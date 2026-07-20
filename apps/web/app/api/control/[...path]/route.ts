import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const base = process.env.API_INTERNAL_URL ?? process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
  const target = new URL(`/${path.map(encodeURIComponent).join("/")}`, base);
  target.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "x-csrf-token", "x-request-id", "origin"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const body = ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer();
  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
  });
  const outgoing = new Headers();
  for (const name of [
    "content-type",
    "content-disposition",
    "x-request-id",
    "etag",
    "cache-control",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) outgoing.append("set-cookie", cookie);
  return new NextResponse(response.body, { status: response.status, headers: outgoing });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
