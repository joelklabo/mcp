import { webln } from "@getalby/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type L402Challenge = {
  invoice?: string;
  payment_hash?: string;
};

function parseWwwAuthenticateForInvoice(header: string | null): string | null {
  if (!header) return null;
  // Example: `L402 invoice="lnbc...", macaroon="none"`
  const m = header.match(/(?:^|,)\s*invoice="([^"]+)"/i);
  return m?.[1] ?? null;
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
    if (typeof parsed?.invoice === "string") invoice = parsed.invoice;
    if (typeof parsed?.payment_hash === "string") paymentHash = parsed.payment_hash;
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

  const headers = new Headers(requestOptions.headers ?? undefined);
  headers.set("X-Payment-Hash", paymentHash);

  // Note: body is a string in this tool; safe to retry.
  const retry: RequestInit = {
    ...requestOptions,
    headers,
  };

  return fetch(url, retry);
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
