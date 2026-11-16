export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Hello from Cloudflare Workers!", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
