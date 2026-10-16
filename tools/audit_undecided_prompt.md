<!-- Agent prompt for tools/audit_undecided_pairs.js batches. Substitute <DIR> (absolute batch dir) and <BATCH> (e.g. b1). -->
You are judging whether pairs of liquor-store listings are the SAME PRODUCT (link) or DIFFERENT products (ignore), for a Canadian spirits price tracker. This is a read-and-judge task. Do NOT run any scripts except to write the output file as described below, do NOT edit any file except the output file named below, do NOT use WebSearch/WebFetch.

1. Read the linking policy first, in full: /home/brennan/spirit-tracker/.worktrees/data/data/sku_link_policy.md
2. Both sides can be whole linked groups (many stores); you judge whether the two GROUPS are the same product.
3. Read the pairs: <DIR>/<BATCH>.pairs.jsonl (one JSON object per line). The file can be larger than one Read returns: read it in chunks with the Read tool's offset/limit (about 20 lines at a time) until you have read EVERY row; never stop early.
   Each line: n (row number), a / b (the two SKUs), prob (a model's match probability; a hint only), classical (a token-overlap score; high values often mean lookalike names, NOT a match) — or, in union batches, gens: each candidate generator's score for the pair (page-*-linear, page-*-ai, rich-gbt, emb-nn are model probabilities, and page-*-ai is known to over-score lookalikes; page-*-classical and classical are token-overlap scores). All are hints only, and A / B = every store listing currently in each side's group: store, name, price, url slug, removed flag. In compact batches A / B instead summarise each group: names (its distinct listing names; moreNames = how many were cut), stores, price (range over live listings), slugs (up to two url slugs).

How to judge each pair (read BOTH sides' listings, every store):
- Same product = same brand, expression, age statement, edition/release/batch/vintage year when stated, cask finish, strength class (cask/batch strength vs standard), and bottle size bucket (700ml and 750ml are the SAME bucket; 350/375 same; 1L, 1.14L, 1.75L, 3L, 50ml minis are each different).
- Different = any STATED difference in age, edition/release number, release year, cask finish, batch-strength vs standard, single cask/private barrel vs core range, gift/taster pack vs single bottle, independent bottler (Adelphi, G&M, Signatory, First Editions, Old Malt Cask, Douglas Laing, etc.) vs the distillery's own bottling, or size bucket.
- Use the url slug; it often states size or edition that the name omits.
- Use price: if one side is ~0.6x or ~1.6x+ the other's price band for what looks like the same name, do NOT link — use "review" (likely a different size, case, or edition, or a mispricing).
- Generic name (no expression/year named) vs a specific release, with nothing telling you which release the generic one is: "review".
- A lookalike pair with a STATED difference (different age number, release/batch/edition number, finish, strength, distillery, bottler, size bucket, gift pack) is ALWAYS "ignore" — these hard negatives are what the next model retrain learns from, so never leave them as review. Use "review" only when the difference might just be a renamed/rebranded label of the same product, or the evidence genuinely conflicts. A wrong "ignore" is permanent, so the difference must be stated, not guessed.
- If a group (A or B) itself looks mixed (contains clearly different products), say so in "why" (include the word "mixed") and use "review".
- When genuinely unsure, "review".

Write ONE file, <DIR>/<BATCH>.decisions.jsonl — one line per pair, every row, in row order:
{"n": <row>, "a": "<sku a>", "b": "<sku b>", "verdict": "link"|"ignore"|"review", "confidence": "high"|"medium"|"low", "why": "<one short sentence naming the decisive evidence>"}
The a / b values must be copied EXACTLY from the pairs file (prefixes like "id:", "u:", "upc:", "c:" included). Retyping them causes errors (6% of rows in the 2026-10-14 pilot): write the file with a short script that takes a and b from the pairs file by row number n and adds your verdict, confidence and why for each n.

Work through every row; do not skip any. When finished, reply with only: row count, counts of link / ignore / review.
