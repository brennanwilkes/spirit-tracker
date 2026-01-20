"use strict";

function normalizeBaseUrl(startUrl) {
  try {
    const u = new URL(startUrl);
    u.hash = "";
    if (u.searchParams && u.searchParams.has("page")) u.searchParams.delete("page");
    u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : "";

    if (!u.pathname.endsWith("/")) u.pathname += "/";
    u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, "/");
    return u.toString();
  } catch {
    return startUrl;
  }
}

function makePageUrl(baseUrl, pageNum) {
  if (pageNum <= 1) return normalizeBaseUrl(baseUrl);
  const u = new URL(baseUrl);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, "/");
  u.pathname = u.pathname + `page/${pageNum}/`;
  u.hash = "";
  return u.toString();
}

function makePageUrlForCtx(ctx, baseUrl, pageNum) {
  const fn = ctx?.store?.makePageUrl;
  return typeof fn === "function" ? fn(baseUrl, pageNum) : makePageUrl(baseUrl, pageNum);
}

function makePageUrlQueryParam(baseUrl, paramName, pageNum) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.hash = "";
  if (pageNum <= 1) u.searchParams.set(paramName, "1");
  else u.searchParams.set(paramName, String(pageNum));
  u.search = `?${u.searchParams.toString()}`;
  return u.toString();
}

function makePageUrlShopifyQueryPage(baseUrl, pageNum) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.hash = "";
  u.searchParams.set("page", String(Math.max(1, pageNum)));
  u.search = `?${u.searchParams.toString()}`;
  return u.toString();
}

module.exports = { normalizeBaseUrl, makePageUrl, makePageUrlForCtx, makePageUrlQueryParam, makePageUrlShopifyQueryPage };
