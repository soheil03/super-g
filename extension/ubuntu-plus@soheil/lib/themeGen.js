// SPDX-License-Identifier: GPL-3.0-or-later
// Turns tokens (tokens.json) + the user's choices into CSS for GTK4/libadwaita,
// GTK3 (on top of adw-gtk3) and GNOME Shell. Pure functions, no GNOME imports,
// so the same code runs in the shell, in prefs and in tools/gen.js.

import {mix, over, onColor, withAlpha} from './color.js';

export const DEFAULTS = {
    palette: 'catppuccin',
    accent: 'auto',
    windowButtons: 'capsule',
    windowRadius: 18,
    sidebarStyle: 'floating-card',
    titleWeight: 600,
};

export function resolve(tokens, opts, dark) {
    const pal = tokens.palettes[opts.palette] ?? tokens.palettes[DEFAULTS.palette];
    const m = dark ? pal.dark : pal.light;
    const accentKey = opts.accent === 'auto' || !tokens.accents[opts.accent]
        ? pal.defaultAccent : opts.accent;
    const accent = tokens.accents[accentKey][dark ? 'dark' : 'light'];
    const raised = dark ? mix(m.fg, m.window, 0.07) : m.view;

    return {
        dark,
        accent,
        accentFg: onColor(accent),
        window: m.window,
        view: m.view,
        fg: m.fg,
        fgMuted: m.fgMuted,
        hairline: m.hairline,
        control: m.control,
        controlHover: mix(m.fg, m.window, dark ? 0.16 : 0.13),
        glass: m.glass,
        sidebar: over(m.sidebarCard, m.window),
        sidebarBackdrop: over(m.sidebarCard, mix(m.window, '#808080', dark ? 0.97 : 0.985)),
        popover: raised,
        card: dark ? withAlpha(m.fg, 0.06) : m.view,
        shade: dark ? 'rgba(0,0,6,.28)' : 'rgba(0,0,6,.07)',
        destructive: dark ? '#f05b63' : '#e5484d',
    };
}

const r = n => `${Math.round(n)}px`;

/* ---------------------------------------------------------------- GTK4 -- */

function gtk4Vars(c) {
    const v = {
        'accent-bg-color': c.accent,
        'accent-fg-color': c.accentFg,
        'window-bg-color': c.window,
        'window-fg-color': c.fg,
        'view-bg-color': c.view,
        'view-fg-color': c.fg,
        'headerbar-bg-color': c.window,
        'headerbar-fg-color': c.fg,
        'headerbar-backdrop-color': c.window,
        'headerbar-border-color': c.fg,
        'headerbar-shade-color': c.shade,
        'sidebar-bg-color': c.sidebar,
        'sidebar-fg-color': c.fg,
        'sidebar-backdrop-color': c.sidebarBackdrop,
        'sidebar-border-color': c.hairline,
        'sidebar-shade-color': c.shade,
        'secondary-sidebar-bg-color': c.sidebar,
        'secondary-sidebar-fg-color': c.fg,
        'secondary-sidebar-backdrop-color': c.sidebarBackdrop,
        'secondary-sidebar-border-color': c.hairline,
        'card-bg-color': c.card,
        'card-fg-color': c.fg,
        'card-shade-color': c.shade,
        'dialog-bg-color': c.popover,
        'dialog-fg-color': c.fg,
        'popover-bg-color': c.popover,
        'popover-fg-color': c.fg,
        'popover-shade-color': c.shade,
        'thumbnail-bg-color': c.popover,
        'thumbnail-fg-color': c.fg,
        'shade-color': c.shade,
    };
    const props = Object.entries(v).map(([k, val]) => `  --${k}: ${val};`).join('\n');
    // Plain GTK4 apps (no libadwaita) still read the named colors.
    const named = Object.entries(v)
        .map(([k, val]) => `@define-color ${k.replace(/-color$/, '').replace(/-/g, '_')}_color ${val};`)
        .join('\n');
    return `${named}\n:root {\n${props}\n}`;
}

function gtk4Buttons(style, c) {
    const wc = 'windowcontrols';
    const base = `
${wc} > button { min-width: 0; min-height: 0; padding: 0; margin: 0; }
${wc} > button > image { transition: background 160ms ease-out, color 160ms ease-out; }
${wc} > button.close:hover > image { background-color: ${c.destructive}; color: #ffffff; }
${wc} > button.close:active > image { background-color: ${mix('#000000', c.destructive, 0.15)}; color: #ffffff; }`;

    if (style === 'mini-dots') {
        return `${base}
${wc}:not(.empty) { border-spacing: 8px; }
${wc} > button > image { min-width: 14px; min-height: 14px; padding: 1px; -gtk-icon-size: 12px;
  border-radius: 100%; background-color: ${c.controlHover}; color: transparent; }
${wc}:hover > button > image { color: ${c.fg}; }
${wc}:backdrop > button > image { background-color: ${c.control}; }`;
    }
    if (style === 'close-emphasized') {
        return `${base}
${wc}:not(.empty) { border-spacing: 4px; }
${wc} > button > image { padding: 5px; border-radius: 8px; background-color: transparent; }
${wc} > button:hover > image { background-color: ${c.control}; }
${wc} > button.close > image { border-radius: 100%; background-color: ${c.control}; }`;
    }
    // capsule (default): one pill holding all three glyphs
    return `${base}
${wc}:not(.empty) { border-spacing: 0; background-color: ${c.control}; border-radius: 999px; padding: 2px; }
${wc}:not(.empty):backdrop { background-color: ${withAlpha(c.fg, 0.04)}; }
${wc} > button > image { padding: 3px 7px; border-radius: 999px; background-color: transparent; }
${wc} > button:hover > image { background-color: ${c.controlHover}; }`;
}

function gtk4Sidebar(style, radius) {
    if (style !== 'floating-card')
        return '';
    const inset = 6;
    const inner = Math.max(6, radius - inset);
    // The pane's border is painted in the window colour so the inner box
    // reads as a card inset in the window; inner radius = outer - border.
    return `
.sidebar-pane:dir(ltr):not(.end), .sidebar-pane.end:dir(rtl) {
  border-style: solid; border-color: var(--window-bg-color);
  border-width: ${inset}px 0 ${inset}px ${inset}px;
  border-radius: ${r(radius)} ${r(inner)} ${r(inner)} ${r(radius)};
  box-shadow: inset 0 0 0 1px var(--sidebar-border-color);
}
.sidebar-pane:dir(rtl):not(.end), .sidebar-pane.end:dir(ltr) {
  border-style: solid; border-color: var(--window-bg-color);
  border-width: ${inset}px ${inset}px ${inset}px 0;
  border-radius: ${r(inner)} ${r(radius)} ${r(radius)} ${r(inner)};
  box-shadow: inset 0 0 0 1px var(--sidebar-border-color);
}
window.maximized .sidebar-pane, window.tiled .sidebar-pane,
window.tiled-left .sidebar-pane, window.tiled-right .sidebar-pane { border-color: var(--window-bg-color); }
.sidebar-pane:backdrop { border-color: var(--window-bg-color); }
.navigation-sidebar > row { border-radius: 10px; }
.navigation-sidebar > row:selected {
  background-color: color-mix(in srgb, var(--accent-bg-color) 18%, transparent); color: var(--accent-color); }
.navigation-sidebar > row:selected:hover { background-color: color-mix(in srgb, var(--accent-bg-color) 24%, transparent); }`;
}

// Drop rules whose selector mentions any of `words` (used to keep only the
// harmless parts of third-party fix-up CSS).
export function withoutRules(css, words) {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return body.split('}').filter(chunk => {
        const sel = chunk.slice(0, chunk.indexOf('{'));
        return chunk.includes('{') && !words.some(w => sel.includes(w));
    }).map(chunk => `${chunk.trim()}\n}`).join('\n');
}

export function gtk4Css(tokens, opts, extraCss = '') {
    opts = {...DEFAULTS, ...opts};
    const light = resolve(tokens, opts, false);
    const dark = resolve(tokens, opts, true);
    return `/* Generated by ubuntu-plus. Edits are overwritten; change settings instead. */
${gtk4Vars(light)}
@media (prefers-color-scheme: dark) {
${gtk4Vars(dark)}
}
:root { --window-radius: ${r(opts.windowRadius)}; }
headerbar .title, windowtitle > .title { font-weight: ${opts.titleWeight}; }
${gtk4Buttons(opts.windowButtons, light)}
@media (prefers-color-scheme: dark) {
${gtk4Buttons(opts.windowButtons, dark)}
}
${extraCss}
${gtk4Sidebar(opts.sidebarStyle, opts.windowRadius)}
`;
}

/* ---------------------------------------------------------------- GTK3 -- */

function gtk3Buttons(style, c) {
    const sel = 'headerbar button.titlebutton, .titlebar button.titlebutton';
    const hov = 'headerbar button.titlebutton:hover, .titlebar button.titlebutton:hover';
    const close = 'headerbar button.titlebutton.close:hover, .titlebar button.titlebutton.close:hover';
    const common = `${close} { background-color: ${c.destructive}; color: #ffffff; }`;
    if (style === 'mini-dots') {
        return `${sel} { min-width: 14px; min-height: 14px; padding: 0; margin: 0 4px; border-radius: 100%;
  background-color: ${c.controlHover}; color: transparent; box-shadow: none; -gtk-icon-transform: scale(0.65); }
headerbar:hover button.titlebutton, .titlebar:hover button.titlebutton { color: ${c.fg}; }
${common}`;
    }
    if (style === 'close-emphasized') {
        return `${sel} { min-width: 24px; min-height: 24px; padding: 0; margin: 0 1px; border-radius: 8px;
  background-color: transparent; box-shadow: none; }
${hov} { background-color: ${c.control}; }
headerbar button.titlebutton.close, .titlebar button.titlebutton.close { border-radius: 100%; background-color: ${c.control}; }
${common}`;
    }
    // GTK3 has no window-controls container, so the capsule becomes three
    // joined pills: minimize rounds left, close rounds right.
    return `${sel} { min-width: 28px; min-height: 22px; padding: 0; margin: 0; border-radius: 0;
  background-color: ${c.control}; box-shadow: none; }
headerbar button.titlebutton.minimize, .titlebar button.titlebutton.minimize { border-radius: 999px 0 0 999px; }
headerbar button.titlebutton.close, .titlebar button.titlebutton.close { border-radius: 0 999px 999px 0; }
${hov} { background-color: ${c.controlHover}; }
${common}`;
}

export function gtk3Css(tokens, opts, dark, adwGtk3Path, extraCss = '') {
    opts = {...DEFAULTS, ...opts};
    const c = resolve(tokens, opts, dark);
    const named = {
        accent_bg_color: c.accent,
        accent_fg_color: c.accentFg,
        accent_color: c.accent,
        window_bg_color: c.window,
        window_fg_color: c.fg,
        view_bg_color: c.view,
        view_fg_color: c.fg,
        headerbar_bg_color: c.window,
        headerbar_fg_color: c.fg,
        headerbar_backdrop_color: c.window,
        headerbar_border_color: c.fg,
        headerbar_shade_color: c.shade,
        sidebar_bg_color: c.sidebar,
        sidebar_fg_color: c.fg,
        sidebar_backdrop_color: c.sidebarBackdrop,
        sidebar_border_color: c.hairline,
        card_bg_color: c.card,
        card_fg_color: c.fg,
        card_shade_color: c.shade,
        dialog_bg_color: c.popover,
        dialog_fg_color: c.fg,
        popover_bg_color: c.popover,
        popover_fg_color: c.fg,
        shade_color: c.shade,
    };
    const defs = Object.entries(named).map(([k, v]) => `@define-color ${k} ${v};`).join('\n');
    return `/* Generated by ubuntu-plus. Edits are overwritten; change settings instead. */
@import url("file://${adwGtk3Path}");
${defs}
decoration { border-radius: ${r(opts.windowRadius)} ${r(opts.windowRadius)} 0 0; }
headerbar.titlebar, .titlebar:not(headerbar) {
  border-top-left-radius: ${r(opts.windowRadius)}; border-top-right-radius: ${r(opts.windowRadius)}; }
.maximized headerbar.titlebar, .tiled headerbar.titlebar, .maximized decoration, .tiled decoration { border-radius: 0; }
headerbar .title { font-weight: ${opts.titleWeight}; }
${extraCss}
button.suggested-action, button.suggested-action label { color: ${c.accentFg}; }
.sidebar, .sidebar list, .sidebar row:not(:selected), placessidebar, stacksidebar,
headerbar.sidebar, .sidebar-pane { background-color: ${c.sidebar}; }
.sidebar row:selected, placessidebar row:selected {
  background-color: ${mix(c.accent, c.sidebar, 0.18)}; color: ${c.fg}; }
${gtk3Buttons(opts.windowButtons, c)}
`;
}

/* --------------------------------------------------------------- Shell -- */

// Every shell actor lives under the stage child named "uiGroup". Prefixing
// our selectors with its id outranks class-only rules from the theme and
// from other extensions (e.g. Blur my Shell's popup styles) without !important.
const ROOT = '#uiGroup';
// A selector that starts with a class may target the root itself (Blur my
// Shell puts its classes on uiGroup), so it also gets a compound form.
const scoped = selector => selector.split(',').flatMap(part => {
    const s = part.trim();
    return s.startsWith('.') ? [`${ROOT} ${s}`, `${ROOT}${s}`] : [`${ROOT} ${s}`];
}).join(',\n');

// Rewrite every declaration that uses the system accent — in the running
// shell theme (Yaru, Adwaita) and in other extensions' stylesheets — so it
// uses our accent. Keeps working when GNOME renames selectors.
export function accentOverrides(themeCss, accent, accentFg) {
    const out = [];
    const body = themeCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const chunk of body.split('}')) {
        const i = chunk.indexOf('{');
        if (i < 0 || !chunk.includes('-st-accent'))
            continue;
        const selector = chunk.slice(0, i).trim();
        if (!selector || selector.startsWith('@'))
            continue;
        const decls = chunk.slice(i + 1).split(';')
            .filter(d => d.includes('-st-accent'))
            .map(d => d.trim()
                .replace(/-st-accent-fg-color/g, accentFg)
                .replace(/-st-accent-color/g, accent));
        if (decls.length)
            out.push(`${scoped(selector)} { ${decls.join('; ')}; }`);
    }
    return out.join('\n');
}

// Blur my Shell marks the UI root with one of these when it blurs popups;
// popups then get a translucent tint so the blur shows through. Our own blur
// module will use the same switch.
const BLUR_CLASSES = ['bms-popup-background-transparent', 'bms-popup-background-light',
    'bms-popup-background-dark', 'bms-popup-surface-transparent', 'bms-popup-surface-light',
    'bms-popup-surface-dark'];
const SURFACES = ['.popup-menu-content', '.candidate-popup-content', '.quick-settings',
    '.switcher-list', '.workspace-switcher', '.osd-window', '.modal-dialog'];

export function shellCss(tokens, opts, dark, themeCss = '') {
    opts = {...DEFAULTS, ...opts};
    const c = resolve(tokens, opts, dark);
    const solid = withAlpha(c.popover, 0.96);
    const glass = withAlpha(c.popover, dark ? 0.74 : 0.62);
    const tile = c.control;
    const rule = (sel, body) => `${scoped(sel)} { ${body} }`;
    const glassSel = BLUR_CLASSES.flatMap(k => SURFACES.map(s => `${ROOT}.${k} ${s}`)).join(',\n');
    return `/* Generated by ubuntu-plus. */
${accentOverrides(themeCss, c.accent, c.accentFg)}

${opts.glass
        // Ubuntu Plus glass draws the surface (blur, tint, rim) underneath.
        ? rule(SURFACES.join(', '), `background-color: transparent; color: ${c.fg}; border: none; box-shadow: 0 12px 36px rgba(0,0,0,${dark ? 0.32 : 0.16});`)
        : `${rule(SURFACES.join(', '), `background-color: ${solid}; color: ${c.fg}; border: 1px solid ${c.hairline};`)}
${glassSel} { background-color: ${glass}; }`}

${rule('.popup-menu-content, .candidate-popup-content', 'border-radius: 16px; padding: 6px;')}
${rule('.popup-menu-item', 'border-radius: 10px;')}
${rule('.popup-menu-item:hover, .popup-menu-item:focus, .popup-menu-item.selected', `background-color: ${tile};`)}
${rule('.popup-separator-menu-item .popup-separator-menu-item-separator', `background-color: ${c.hairline};`)}

${rule('.quick-settings', 'border-radius: 24px; padding: 14px;')}
${rule('.quick-toggle', `border-radius: 999px; background-color: ${tile}; color: ${c.fg};`)}
${rule('.quick-toggle:hover', `background-color: ${c.controlHover};`)}
${rule('.quick-menu-toggle .quick-toggle-arrow', 'border-radius: 0 999px 999px 0;')}
${rule('.quick-toggle-menu', `border-radius: 20px; background-color: ${withAlpha(c.fg, 0.05)};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button', `background-color: ${tile}; color: ${c.fg};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:hover', `background-color: ${c.controlHover};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:checked', `background-color: ${c.accent}; color: ${c.accentFg};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:checked:hover', `background-color: ${mix('#000000', c.accent, 0.08)};`)}
${rule('.quick-toggle-has-menu .quick-toggle-separator', `background-color: ${withAlpha(c.fg, 0.12)};`)}
${rule('.slider', `color: #ffffff; -barlevel-height: 6px; -barlevel-background-color: ${withAlpha(c.fg, 0.12)}; -slider-handle-radius: 9px; -slider-handle-border-width: 1px; -slider-handle-border-color: rgba(0,0,0,0.14);`)}
${rule('.quick-settings-system-item .icon-button, .quick-settings-system-item .button', `border-radius: 999px; background-color: ${tile};`)}

${rule('.datemenu-popover .popup-menu-content, #calendarArea', 'border-radius: 24px;')}
${rule('.message', `border-radius: 16px; background-color: ${tile}; color: ${c.fg};`)}
${rule('.message:hover', `background-color: ${c.controlHover};`)}
${rule('.notification-banner', 'border-radius: 20px;')}
${rule('.events-button, .world-clocks-button, .weather-button', `border-radius: 16px; background-color: ${tile}; color: ${c.fg};`)}

${rule('.modal-dialog', 'border-radius: 24px;')}
${rule('.modal-dialog-linked-button', 'border-radius: 999px;')}
${rule('.switcher-list, .workspace-switcher', 'border-radius: 24px;')}
${rule('.switcher-list .item-box', 'border-radius: 16px;')}
${rule('.osd-window', 'border-radius: 999px;')}

${rule('.search-entry', `background-color: ${withAlpha(c.window, dark ? 0.55 : 0.6)}; color: ${c.fg}; border-radius: 999px; border: none; box-shadow: inset 0 0 0 1px ${c.hairline};`)}
${rule('.search-entry:focus', `box-shadow: inset 0 0 0 2px ${withAlpha(c.accent, 0.6)};`)}
${rule('.search-entry .search-entry-icon, .search-entry StLabel.hint-text', `color: ${c.fgMuted};`)}
`;
}

/* --------------------------------------------------------------- Theme -- */

export function gtkThemeIndex(name) {
    return `[Desktop Entry]
Type=X-GNOME-Metatheme
Name=${name}
Comment=Generated by ubuntu-plus (adw-gtk3 base)
Encoding=UTF-8

[X-GNOME-Metatheme]
GtkTheme=${name}
`;
}
