import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNativeRequestService,
  createNativeRequestTransport,
} from "./index.js";
import { normalizeRequestHeaders } from "./normalize.js";

describe("native-request", () => {
  describe("normalizeRequestHeaders", () => {
    it("adds content-type application/json only when the method can carry a body and data is provided", () => {
      const postHeaders = normalizeRequestHeaders(undefined, "POST", { a: 1 });
      expect(postHeaders.get("content-type")).toBe("application/json");
    });

    it("does not add content-type for bodyless GET requests", () => {
      const getHeaders = normalizeRequestHeaders(undefined, "GET", undefined);
      expect(getHeaders.has("content-type")).toBe(false);
    });

    it("does not add content-type for bodyless HEAD requests", () => {
      const headHeaders = normalizeRequestHeaders(undefined, "HEAD", undefined);
      expect(headHeaders.has("content-type")).toBe(false);
    });

    it("does not duplicate content-type when the caller supplies a differently-cased header", () => {
      const headers = normalizeRequestHeaders(
        { "content-type": "application/x-www-form-urlencoded" },
        "POST",
        { a: 1 },
      );
      expect(headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
    });

    it("preserves unrelated headers", () => {
      const headers = normalizeRequestHeaders(
        { "x-token": "abc" },
        "GET",
        undefined,
      );
      expect(headers.get("x-token")).toBe("abc");
    });
  });

  describe("transport.request", () => {
    let server: http.Server;
    let serverUrl: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("error", () => {
          if (!res.writableEnded) res.destroy();
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (req.method === "POST" && req.url === "/echo") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                method: req.method,
                headers: req.headers,
                body,
              }),
            );
            return;
          }
          if (req.url === "/unauthorized") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
          if (req.url === "/text") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("hello");
            return;
          }
          if (req.url === "/binary") {
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
            });
            res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
            return;
          }
          if (req.url?.startsWith("/query")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ query: req.url }));
            return;
          }
          res.writeHead(404);
          res.end("not found");
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            serverUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    const transport = createNativeRequestTransport();

    it("resolves a 200 JSON response via success with parsed data", async () => {
      const result = await transport.request(
        "r1",
        { url: `${serverUrl}/query?x=1` },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.statusCode).toBe(200);
      expect(result.errMsg).toBe("request:ok");
      expect((result.data as { query: string }).query).toContain("/query?x=1");
    });

    it("resolves a 401 response via success, never fail", async () => {
      const result = await transport.request(
        "r2",
        { url: `${serverUrl}/unauthorized` },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.statusCode).toBe(401);
      expect(result.errMsg).toBe("request:ok");
      expect((result.data as { error: string }).error).toBe("unauthorized");
    });

    it("encodes object data into the query string for GET", async () => {
      const result = await transport.request(
        "r3",
        { url: `${serverUrl}/query`, method: "GET", data: { a: 1, b: 2 } },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      const query = (result.data as { query: string }).query;
      expect(query).toContain("a=1");
      expect(query).toContain("b=2");
      expect(query).toContain("/query?");
    });

    it("sends a JSON body for POST and defaults content-type to application/json", async () => {
      const result = await transport.request(
        "r4",
        { url: `${serverUrl}/echo`, method: "POST", data: { a: 1 } },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.statusCode).toBe(200);
      const parsed = result.data as {
        body: string;
        headers: Record<string, string>;
      };
      expect(parsed.headers["content-type"]).toBe("application/json");
      expect(parsed.body).toBe('{"a":1}');
    });

    it("sends a form-encoded body when content-type is application/x-www-form-urlencoded", async () => {
      const result = await transport.request(
        "r5",
        {
          url: `${serverUrl}/echo`,
          method: "POST",
          data: { a: 1, b: 2 },
          header: { "content-type": "application/x-www-form-urlencoded" },
        },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      const parsed = result.data as {
        body: string;
        headers: Record<string, string>;
      };
      expect(parsed.headers["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(parsed.body).toContain("a=1");
      expect(parsed.body).toContain("b=2");
    });

    it("returns text as a string when dataType is not json", async () => {
      const result = await transport.request(
        "r6",
        { url: `${serverUrl}/text`, dataType: "text" },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.data).toBe("hello");
    });

    it("returns an ArrayBuffer when responseType is arraybuffer", async () => {
      const result = await transport.request(
        "r7",
        { url: `${serverUrl}/binary`, responseType: "arraybuffer" },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.data).toBeInstanceOf(ArrayBuffer);
      expect((result.data as ArrayBuffer).byteLength).toBe(4);
    });

    it("fails with a timeout when the response does not arrive in time", async () => {
      const slowServer = http.createServer((_req, res) => {
        setTimeout(() => res.end("late"), 100);
      });
      await new Promise<void>((resolve) =>
        slowServer.listen(0, "127.0.0.1", resolve),
      );
      const addr = slowServer.address();
      const url = `http://127.0.0.1:${(addr as { port: number }).port}`;
      const result = await transport.request(
        "r8",
        { url, timeout: 10 },
        new AbortController().signal,
      );
      slowServer.close();
      expect("statusCode" in result).toBe(false);
      if ("statusCode" in result) return;
      expect(result.errMsg).toBe("request:fail timeout");
    });

    it("fails when the network connection is refused", async () => {
      const result = await transport.request(
        "r9",
        { url: "http://127.0.0.1:1/" },
        new AbortController().signal,
      );
      expect("statusCode" in result).toBe(false);
    });

    it("fails with abort when the caller aborts the request", async () => {
      const controller = new AbortController();
      const promise = transport.request(
        "r10",
        { url: `${serverUrl}/query` },
        controller.signal,
      );
      controller.abort();
      const result = await promise;
      expect("statusCode" in result).toBe(false);
      if ("statusCode" in result) return;
      expect(result.errMsg).toBe("request:fail abort");
    });
  });

  describe("createNativeRequestService", () => {
    let server: http.Server;
    let serverUrl: string;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 200);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            serverUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("aborts an in-flight request when the owner is disposed", async () => {
      const service = createNativeRequestService();
      const promise = service.request("owner-1", "r11", {
        url: serverUrl,
        timeout: 5_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      service.disposeOwner("owner-1");
      const result = await promise;
      expect("statusCode" in result).toBe(false);
      if ("statusCode" in result) return;
      expect(result.errMsg).toBe("request:fail abort");
    });

    it("does not abort a request that belongs to another owner", async () => {
      const service = createNativeRequestService();
      const promise = service.request("owner-2", "r12", {
        url: serverUrl,
        timeout: 5_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      service.disposeOwner("other-owner");
      const result = await promise;
      expect("statusCode" in result).toBe(true);
      if (!("statusCode" in result)) return;
      expect(result.statusCode).toBe(200);
    });
  });
});
