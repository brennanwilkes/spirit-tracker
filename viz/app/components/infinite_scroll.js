/**
 * IntersectionObserver-based infinite scroll helper.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.sentinel     - element to observe (last visible item or a spacer)
 * @param {function}    opts.onLoadMore   - called when sentinel enters the viewport
 * @param {string}      [opts.rootMargin="600px 0px"] - preload margin
 * @returns {{ destroy }}
 */
export function createInfiniteScroll({ sentinel, onLoadMore, rootMargin = "600px 0px" } = {}) {
	const io = new IntersectionObserver(
		(entries) => {
			const hit = entries.some((x) => x.isIntersecting);
			if (hit) onLoadMore?.();
		},
		{ root: null, rootMargin, threshold: 0.01 },
	);

	io.observe(sentinel);

	return {
		destroy() {
			io.disconnect();
		},
	};
}
