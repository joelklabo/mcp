import { webln } from "@getalby/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type L402Challenge = {
  invoice?: string;
  payment_hash?: string;
};

function normalizeMaybeString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const lowered = s.toLowerCase();
  // Guard against the common bug where `undefined` gets stringified into JSON.
  if (lowered === "undefined" || lowered === "null") return null;
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWwwAuthenticateForInvoice(header: string | null): string | null {
  if (!header) return null;
  // Example: `L402 invoice="lnbc...", macaroon="none"`
  const m = header.match(/(?:^|,)\s*invoice="([^"]+)"/i);
  return normalizeMaybeString(m?.[1]);
}

function withPaymentHashQueryParam(url: string, paymentHash: string): string {
  const u = new URL(url);
  // Many L402-ish APIs accept the payment hash via query string.
  // This also avoids conflicts when the caller already uses `Authorization: Bearer ...`.
  // Always overwrite any existing payment_hash (it may be empty/"undefined" from a caller's initial request).
  u.searchParams.set("payment_hash", paymentHash);
  return u.toString();
}

async function isPaymentPending(res: Response): Promise<boolean> {
  if (res.status !== 402) return false;

  // The inspector error we've seen is:
  // {"error":"payment not found or not yet confirmed","payment_hash":"..."}
  // Use a cloned response so callers can still read the real body.
  const bodyText = await res.clone().text();

  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (typeof parsed?.error === "string") {
      const msg = parsed.error.toLowerCase();
      return (
        msg.includes("not yet confirmed") ||
        msg.includes("payment not found") ||
        msg.includes("payment not yet confirmed")
      );
    }
  } catch {
    // Ignore: body might not be JSON.
  }

  const lowered = bodyText.toLowerCase();
  return lowered.includes("not yet confirmed") || lowered.includes("payment not found");
}

async function extractL402Challenge(res: Response): Promise<{
  invoice: string | null;
  paymentHash: string | null;
  bodyText: string;
}> {
  const bodyText = await res.text();

  let invoice: string | null = null;
  let paymentHash: string | null = null;

  try {
    const parsed = JSON.parse(bodyText) as L402Challenge;
    invoice = normalizeMaybeString(parsed?.invoice);
    paymentHash = normalizeMaybeString(parsed?.payment_hash);
  } catch {
    // Not JSON, fall back to headers below.
  }

  if (!invoice) {
    invoice = parseWwwAuthenticateForInvoice(res.headers.get("www-authenticate"));
  }

  return { invoice, paymentHash, bodyText };
}

async function fetchWithL402(
  url: string,
  requestOptions: RequestInit,
  provider: webln.NostrWebLNProvider
): Promise<Response> {
  const first = await fetch(url, requestOptions);
  if (first.status !== 402) return first;

  const { invoice, paymentHash, bodyText } = await extractL402Challenge(first);
  if (!invoice) {
    throw new Error(
      `L402 challenge missing invoice. status=${first.status} body=${bodyText}`
    );
  }
  if (!paymentHash) {
    // Avoid sending "undefined" as payment hash; fail loudly so integrators can fix the server response.
    throw new Error(
      `L402 challenge missing payment_hash. status=${first.status} body=${bodyText}`
    );
  }

  await provider.sendPayment(invoice);

  const retryUrl = withPaymentHashQueryParam(url, paymentHash);

  const headers = new Headers(requestOptions.headers ?? undefined);
  headers.set("X-Payment-Hash", paymentHash);
  // Some servers retry using `Authorization: L402 <payment_hash>` instead of `X-Payment-Hash`.
  // Only set this if the caller didn't already supply Authorization.
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `L402 ${paymentHash}`);
  }

  // Note: body is a string in this tool; safe to retry.
  const retry: RequestInit = {
    ...requestOptions,
    headers,
  };

  // Some services take a short moment to confirm the payment after WebLN returns.
  // If we retry too quickly, we can get a second 402 with "payment not found or not yet confirmed".
  const backoffsMs = [0, 250, 750, 1500];
  let last: Response | null = null;
  for (const delay of backoffsMs) {
    if (delay > 0) await sleep(delay);
    const res = await fetch(retryUrl, retry);
    last = res;
    if (res.status !== 402) return res;
    if (!(await isPaymentPending(res))) return res;
  }

  return last ?? (await fetch(retryUrl, retry));
}

export function registerFetchL402Tool(
  server: McpServer,
  webln: webln.NostrWebLNProvider
) {
  server.registerTool(
    "fetch_l402",
    {
      title: "Fetch L402",
      description: "Fetch a paid resource protected by L402",
      inputSchema: {
        url: z.string().describe("the URL to fetch"),
        method: z
          .string()
          .nullish()
          .describe("HTTP request method. Default GET"),
        body: z
          .string()
          .nullish()
          .describe(
            "HTTP request body as a string (either plaintext or stringified JSON)"
          ),
      },
      outputSchema: {
        content: z.string().describe("Response content"),
      },
    },
    async (params) => {
      const requestOptions: RequestInit = {
        method: params.method || undefined,
      };

      if (
        params.method &&
        params.method !== "GET" &&
        params.method !== "HEAD"
      ) {
        requestOptions.body = params.body;
        requestOptions.headers = {
          "Content-Type": "application/json",
        };
      }

      const result = await fetchWithL402(params.url, requestOptions, webln);

      const responseContent = await result.text();
      if (!result.ok) {
        console.error(
          "L402 fetch returned non-OK status",
          result.status,
          responseContent
        );
        throw new Error(
          "fetch returned non-OK status: " +
            result.status +
            " " +
            responseContent
        );
      }

      const responseData = {
        content: responseContent,
      };

      return {
        content: [
          {
            type: "text",
            text: responseContent,
          },
        ],
        structuredContent: responseData,
      };
    }
  );
}
