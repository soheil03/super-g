// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny color helpers shared by the theme generator. Pure JS: runs in
// gnome-shell, in prefs and under plain `gjs -m` for the CLI tools.

export function parse(str) {
    str = str.trim();
    if (str.startsWith('#')) {
        let h = str.slice(1);
        if (h.length === 3)
            h = [...h].map(c => c + c).join('');
        const n = parseInt(h.slice(0, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
        return {r: n >> 16, g: (n >> 8) & 255, b: n & 255, a};
    }
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m)
        throw new Error(`Unsupported color: ${str}`);
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return {r, g, b, a};
}

const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = v => clamp(v).toString(16).padStart(2, '0');

export function toHex(c) {
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function toCss(c) {
    if (c.a >= 1)
        return toHex(c);
    return `rgba(${clamp(c.r)},${clamp(c.g)},${clamp(c.b)},${+c.a.toFixed(3)})`;
}

export function withAlpha(str, a) {
    return toCss({...parse(str), a});
}

// Paint `top` (may be translucent) over an opaque `bottom`, then optionally
// mix in extra `amount` of top. Returns an opaque hex.
export function over(top, bottom) {
    const t = parse(top), b = parse(bottom);
    const mixc = k => t[k] * t.a + b[k] * (1 - t.a);
    return toHex({r: mixc('r'), g: mixc('g'), b: mixc('b'), a: 1});
}

// Linear sRGB mix: `amount` of `a` into `b` (0..1).
export function mix(a, b, amount) {
    const x = parse(a), y = parse(b);
    const m = k => x[k] * amount + y[k] * (1 - amount);
    return toCss({r: m('r'), g: m('g'), b: m('b'), a: x.a * amount + y.a * (1 - amount)});
}

export function luminance(str) {
    const {r, g, b} = parse(str);
    const lin = v => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Foreground that reads on `bg`: white unless the background is light.
export function onColor(bg) {
    return luminance(bg) > 0.42 ? '#15151c' : '#ffffff';
}
