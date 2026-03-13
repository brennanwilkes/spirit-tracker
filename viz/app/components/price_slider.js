/**
 * Exponential price slider component.
 *
 * Maps a linear 0–1000 range input to an exponential price scale so that
 * low prices (< $100) have fine-grained control.
 *
 * @param {object} opts
 * @param {HTMLInputElement} opts.sliderEl     - the <input type="range"> element
 * @param {HTMLElement}      opts.labelEl      - element that shows the current price
 * @param {number}           opts.boundMax     - maximum price on the page
 * @param {number}           [opts.minPrice=25] - minimum slider price
 * @param {function}         [opts.onChange]   - called with (price) when user moves slider
 * @returns {{ getPrice, setPrice, disable }}
 */
export function createPriceSlider({ sliderEl, labelEl, boundMax, minPrice = 25, onChange } = {}) {
	const MIN = minPrice;
	const MAX = boundMax > MIN ? boundMax : MIN;

	function priceFromT(t) {
		t = Math.max(0, Math.min(1, t));
		if (MAX <= MIN) return MIN;
		const ratio = MAX / MIN;
		return MIN * Math.exp(Math.log(ratio) * t);
	}

	function tFromPrice(price) {
		if (!Number.isFinite(price)) return 1;
		if (MAX <= MIN) return 1;
		const p = Math.max(MIN, Math.min(MAX, price));
		const ratio = MAX / MIN;
		return Math.log(p / MIN) / Math.log(ratio);
	}

	function stepForPrice(p) {
		const x = Number.isFinite(p) ? p : MAX;
		if (x < 120) return 5;
		if (x < 250) return 10;
		if (x < 600) return 25;
		return 100;
	}

	function roundToStep(p) {
		const step = stepForPrice(p);
		return Math.round(p / step) * step;
	}

	function clampPrice(p) {
		if (!Number.isFinite(p)) return MAX;
		return Math.max(MIN, Math.min(MAX, p));
	}

	function clampAndRound(p) {
		return clampPrice(roundToStep(clampPrice(p)));
	}

	function formatDollars(p) {
		if (!Number.isFinite(p)) return "";
		return `$${Math.round(p)}`;
	}

	function setSliderFromPrice(p) {
		const t = tFromPrice(p);
		sliderEl.value = String(Math.round(t * 1000));
	}

	function getPriceFromSlider() {
		const v = Number(sliderEl.value);
		const t = Number.isFinite(v) ? v / 1000 : 1;
		return clampPrice(priceFromT(t));
	}

	function updateLabel(p) {
		if (labelEl) labelEl.textContent = formatDollars(p);
	}

	sliderEl.addEventListener("input", () => {
		const raw = getPriceFromSlider();
		const snapped = clampAndRound(raw);
		updateLabel(snapped);
		if (onChange) onChange(snapped);
	});

	sliderEl.addEventListener("change", () => {
		const raw = getPriceFromSlider();
		const snapped = clampAndRound(raw);
		setSliderFromPrice(snapped);
		updateLabel(snapped);
		if (onChange) onChange(snapped);
	});

	return {
		getPrice() {
			return clampAndRound(getPriceFromSlider());
		},
		setPrice(p) {
			const snapped = clampAndRound(p);
			setSliderFromPrice(snapped);
			updateLabel(snapped);
		},
		clampAndRound,
		disable() {
			sliderEl.disabled = true;
		},
	};
}
