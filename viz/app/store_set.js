// viz/app/store_set.js
//
// Shared "store set" model: a selection of stores that any list surface
// (search page, store page) can filter by. One spec, several shapes, and a
// compact URL-encodable form so a filtered view is shareable/bookmarkable.
//
// A spec is one of:
//   { kind: "all" }                                  — no filter
//   { kind: "region", region: "bc" | "ab" }          — built-in region preset
//   { kind: "city",   city: "<cityId>" }             — built-in metro preset
//   { kind: "stores", ids: ["bsw", "kwm", ...] }     — ad-hoc multi-select
//   { kind: "mine" }                                 — the signed-in user's saved set
//
// `resolveStoreSet` returns a Set<storeId> to filter by, or `null` meaning
// "no filter" (all stores). Consumers should treat `null` as a pass-through.

import { STORES, storesByRegion, storesByCity, allCities, storeById, cityLabel } from "./stores.js";

export const ALL_STORE_SET = { kind: "all" };

const REGION_LABELS = { bc: "British Columbia", ab: "Alberta" };

export function resolveStoreSet(spec, { myStores = null } = {}) {
	if (!spec || spec.kind === "all") return null;
	if (spec.kind === "region") return new Set(storesByRegion(spec.region).map((s) => s.id));
	if (spec.kind === "city") return new Set(storesByCity(spec.city).map((s) => s.id));
	if (spec.kind === "stores") return new Set((spec.ids || []).filter((id) => storeById(id)));
	if (spec.kind === "mine") {
		const ids = Array.isArray(myStores) ? myStores.filter((id) => storeById(id)) : [];
		return new Set(ids);
	}
	return null;
}

export function serializeStoreSet(spec) {
	if (!spec || spec.kind === "all") return "";
	if (spec.kind === "region") return `region:${spec.region}`;
	if (spec.kind === "city") return `city:${spec.city}`;
	if (spec.kind === "mine") return "mine";
	if (spec.kind === "stores") return `stores:${(spec.ids || []).join(",")}`;
	return "";
}

export function parseStoreSet(str) {
	const s = String(str || "").trim();
	if (!s) return { kind: "all" };
	if (s === "mine") return { kind: "mine" };

	const idx = s.indexOf(":");
	const k = idx === -1 ? s : s.slice(0, idx);
	const v = idx === -1 ? "" : s.slice(idx + 1);

	if (k === "region" && (v === "bc" || v === "ab")) return { kind: "region", region: v };
	if (k === "city" && v) return { kind: "city", city: v };
	if (k === "stores" && v) {
		const ids = v.split(",").map((x) => x.trim()).filter(Boolean);
		if (ids.length) return { kind: "stores", ids };
	}
	return { kind: "all" };
}

export function storeSetLabel(spec) {
	if (!spec || spec.kind === "all") return "All stores";
	if (spec.kind === "region") return REGION_LABELS[spec.region] || spec.region;
	if (spec.kind === "city") return cityLabel(spec.city);
	if (spec.kind === "mine") return "My Stores";
	if (spec.kind === "stores") {
		const ids = (spec.ids || []).filter((id) => storeById(id));
		if (!ids.length) return "All stores";
		if (ids.length === 1) return storeById(ids[0]).label;
		if (ids.length === 2) return ids.map((id) => storeById(id).label).join(" + ");
		return `${ids.length} stores`;
	}
	return "All stores";
}

// Built-in presets, in display order. `mine` is appended by the UI only when a
// user is signed in (it needs profile data the model layer doesn't have).
export function builtInPresets() {
	const presets = [
		{ spec: { kind: "all" }, label: "All" },
		{ spec: { kind: "region", region: "bc" }, label: "BC" },
		{ spec: { kind: "region", region: "ab" }, label: "Alberta" },
	];
	for (const c of allCities()) {
		presets.push({ spec: { kind: "city", city: c.id }, label: c.label });
	}
	return presets;
}

// True when two specs select the same thing (used to highlight the active preset).
export function sameStoreSet(a, b) {
	return serializeStoreSet(a) === serializeStoreSet(b);
}

export { STORES };
