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
    sidebarRadius: 14,
    sidebarAccentIcons: true,
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
        // A whisper of the accent, so the card reads as colour rather than grey.
        sidebar: mix(over(m.sidebarCard, m.window), accent, 0.96),
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
    // Adwaita's own buttons, at their normal size.
    if (style === 'adwaita')
        return '';
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

// The X11 frame runs without libadwaita, so it has no colour variables to read.
const frameTitle = c => `window.csd > .titlebar > headerbar { background: ${c.window}; color: ${c.fg}; }`;

function gtk4Sidebar(opts) {
    const {sidebarStyle: style, windowRadius: radius, sidebarRadius: card, sidebarAccentIcons: tinted} = opts;
    // Rows and their selection read the same on any sidebar; only the card is optional.
    const rows = `
.navigation-sidebar { padding: 4px 0; background: none; }
.navigation-sidebar > row { border-radius: 10px; margin: 1px 8px; padding: 0 10px; min-height: 32px; }
/* Settings builds its rows with roomy margins in code. */
.navigation-sidebar > row > grid { margin-top: -7px; margin-bottom: -7px; }
.navigation-sidebar > row:hover { background-color: color-mix(in srgb, var(--sidebar-fg-color) 6%, transparent); }
.navigation-sidebar > row:active { background-color: color-mix(in srgb, var(--sidebar-fg-color) 10%, transparent); }
.navigation-sidebar > row:selected { background-color: color-mix(in srgb, var(--accent-bg-color) 20%, transparent); color: var(--sidebar-fg-color); font-weight: 500; }
.navigation-sidebar > row:selected:hover { background-color: color-mix(in srgb, var(--accent-bg-color) 26%, transparent); }
.navigation-sidebar > row:selected image { color: var(--accent-color); }
.navigation-sidebar > separator, .navigation-sidebar > row > separator { margin: 6px 18px; background-color: color-mix(in srgb, var(--sidebar-fg-color) 9%, transparent); }
${tinted ? `.sidebar-pane .navigation-sidebar > row image, placessidebar row image { color: var(--accent-color); }
.sidebar-pane .navigation-sidebar > row button image, placessidebar row button image { color: inherit; }` : ''}`;
    if (style !== 'floating-card')
        return rows;
    const inset = 8;
    // A margin rather than a window-coloured border, so the card can cast a real shadow.
    return `
.sidebar-pane:dir(ltr):not(.end), .sidebar-pane.end:dir(rtl) { margin: ${inset}px 0 ${inset}px ${inset}px; }
.sidebar-pane:dir(rtl):not(.end), .sidebar-pane.end:dir(ltr) { margin: ${inset}px ${inset}px ${inset}px 0; }
.sidebar-pane {
  border: none; border-radius: ${r(card)};
  box-shadow: 0 0 0 1px var(--sidebar-border-color), 0 2px 8px var(--sidebar-shade-color);
}
.sidebar-pane headerbar { background: none; box-shadow: none; }
window.maximized .sidebar-pane, window.tiled .sidebar-pane, window.tiled-left .sidebar-pane, window.tiled-right .sidebar-pane { border-radius: ${r(Math.min(card, radius))}; }
${rows}`;
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
    return `/* Generated by super-g. Edits are overwritten; change settings instead. */
${gtk4Vars(light)}
@media (prefers-color-scheme: dark) {
${gtk4Vars(dark)}
}
:root { --window-radius: ${r(opts.windowRadius)}; }
headerbar .title, windowtitle > .title { font-weight: ${opts.titleWeight}; }
/* Title bars the compositor draws for X11 apps: their header sits in a .titlebar box. */
window.csd > .titlebar > headerbar { padding-left: 8px; padding-right: 8px; }
/* GTK's own ring stops where an X11 app's content starts; the corners engine draws one around everything. */
window.csd { outline: none; }
${gtk4Buttons(opts.windowButtons, light)}
${frameTitle(light)}
@media (prefers-color-scheme: dark) {
${gtk4Buttons(opts.windowButtons, dark)}
${frameTitle(dark)}
}
${extraCss}
${gtk4Sidebar(opts)}
`;
}

/* ---------------------------------------------------------------- GTK3 -- */

function gtk3Buttons(style, c) {
    if (style === 'adwaita')
        return '';
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
    return `/* Generated by super-g. Edits are overwritten; change settings instead. */
@import url("file://${adwGtk3Path}");
${defs}
decoration { border-radius: ${r(opts.windowRadius)} ${r(opts.windowRadius)} 0 0; }
headerbar.titlebar, .titlebar:not(headerbar) {
  border-top-left-radius: ${r(opts.windowRadius)}; border-top-right-radius: ${r(opts.windowRadius)}; }
.maximized headerbar.titlebar, .tiled headerbar.titlebar, .maximized decoration, .tiled decoration { border-radius: 0; }
headerbar .title { font-weight: ${opts.titleWeight}; }
/* Chromium and Electron take their title bar's edge spacing from this. */
headerbar.titlebar { padding-left: 12px; padding-right: 12px; }
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
    // Every state GNOME styles, or its dark tile shows through under our dark
    // text: the first search result is :highlighted, not :selected.
    const tileStates = sel => {
        const list = states => states.map(s => `${sel}:${s}`).join(', ');
        return `${rule(list(['hover']), `background-color: ${withAlpha(c.fg, dark ? 0.1 : 0.08)}; color: ${c.fg};`)}
${rule(list(['focus', 'selected', 'highlighted', 'checked']), `background-color: ${withAlpha(c.accent, 0.22)}; color: ${c.fg};`)}
${rule(list(['active']), `background-color: ${withAlpha(c.accent, 0.3)}; color: ${c.fg};`)}`;
    };
    const glassSel = BLUR_CLASSES.flatMap(k => SURFACES.map(s => `${ROOT}.${k} ${s}`)).join(',\n');
    return `/* Generated by super-g. */
${accentOverrides(themeCss, c.accent, c.accentFg)}

${rule(SURFACES.join(', '), `background-color: ${solid}; color: ${c.fg}; border: 1px solid ${c.hairline};`)}
${opts.glass
        // Solid until glass is really behind a surface, which the module marks:
        // not during lock, not if the module died, not on one it doesn't cover.
        ? rule(SURFACES.map(s => `${s}.super-g-glassed`).join(', '), 'background-color: transparent; border: none; box-shadow: none;')
        : `${glassSel} { background-color: ${glass}; }`}

${rule('.popup-menu-content, .candidate-popup-content', 'border-radius: 16px; padding: 6px;')}
${rule('.popup-menu-item', 'border-radius: 10px;')}
${rule('.popup-menu-item:hover, .popup-menu-item:focus, .popup-menu-item.selected', `background-color: ${tile};`)}
${rule('.popup-separator-menu-item .popup-separator-menu-item-separator', `background-color: ${c.hairline};`)}

${rule('.quick-settings', 'border-radius: 24px; padding: 14px;')}
${rule('.quick-toggle', `border-radius: 999px; background-color: ${tile}; color: ${c.fg};`)}
${rule('.quick-toggle-has-menu .quick-toggle:ltr', 'border-radius: 999px 0 0 999px;')}
${rule('.quick-toggle-has-menu .quick-toggle:rtl', 'border-radius: 0 999px 999px 0;')}
${rule('.quick-toggle-has-menu .quick-toggle:ltr:last-child, .quick-toggle-has-menu .quick-toggle:rtl:last-child', 'border-radius: 999px;')}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:ltr', 'border-radius: 0 999px 999px 0;')}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:rtl', 'border-radius: 999px 0 0 999px;')}
${rule('.quick-toggle:hover', `background-color: ${c.controlHover};`)}
${rule('.quick-menu-toggle .quick-toggle-arrow', 'border-radius: 0 999px 999px 0;')}
${rule('.quick-toggle-menu', `border-radius: 22px; background-color: ${withAlpha(c.popover, 0.98)}; color: ${c.fg}; box-shadow: inset 0 0 0 1px ${c.hairline};`)}
${rule('.quick-toggle-menu .header .title, .quick-toggle-menu .popup-menu-item', `color: ${c.fg};`)}
${rule('.quick-toggle-menu .header .subtitle, .quick-toggle-menu .popup-inactive-menu-item, .quick-toggle-menu .popup-menu-item:insensitive', `color: ${withAlpha(c.fg, 0.72)};`)}
${rule('.quick-toggle-menu .header .icon', `background-color: ${tile}; color: ${c.fg};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button', `background-color: ${tile}; color: ${c.fg};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:hover', `background-color: ${c.controlHover};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:checked', `background-color: ${c.accent}; color: ${c.accentFg};`)}
${rule('.quick-toggle-has-menu .quick-toggle-menu-button:checked:hover', `background-color: ${mix('#000000', c.accent, 0.08)};`)}
${rule('.quick-toggle-has-menu .quick-toggle-separator', `background-color: ${withAlpha(c.fg, 0.12)};`)}
${rule('.slider', `color: #ffffff; -barlevel-height: 6px; -barlevel-background-color: ${withAlpha(c.fg, 0.12)}; -slider-handle-radius: 9px; -slider-handle-border-width: 1px; -slider-handle-border-color: rgba(0,0,0,0.14);`)}
${rule('.quick-settings-system-item .icon-button, .quick-settings-system-item .button', `border-radius: 999px; background-color: ${tile};`)}

${rule('.datemenu-popover .popup-menu-content, #calendarArea', 'border-radius: 24px;')}
${rule('.calendar .calendar-day, .calendar .calendar-day-heading, .calendar .calendar-week-number', `background-color: transparent; color: ${c.fg}; box-shadow: none; border: none;`)}
${rule('.calendar .calendar-day:hover, .calendar .calendar-day:focus', `background-color: ${tile};`)}
${rule('.calendar .calendar-nonwork-day, .calendar .calendar-other-month', `color: ${c.fgMuted};`)}
${rule('.calendar .calendar-day.calendar-today', `background-color: ${c.accent}; color: ${c.accentFg}; font-weight: bold;`)}
${rule('.calendar .calendar-day-with-events', `color: ${c.fg}; font-weight: bold;`)}
${rule('.calendar .calendar-month-header .pager-button, .calendar .calendar-month-label', `background-color: transparent; color: ${c.fg}; box-shadow: none;`)}
${rule('.calendar .calendar-month-header .pager-button:hover', `background-color: ${tile};`)}
${rule('.datemenu-today-button .day-label, .datemenu-today-button .date-label', `color: ${c.fg};`)}
${rule('.datemenu-today-button', `background-color: transparent;`)}
${rule('.events-button .events-title, .world-clocks-button .world-clocks-header, .weather-button .weather-header', `color: ${withAlpha(c.fg, 0.78)};`)}
${rule('.events-button, .world-clocks-button, .weather-button', `color: ${c.fg};`)}
${rule('.message', `border-radius: 16px; background-color: ${tile}; color: ${c.fg};`)}
${rule('.message:hover', `background-color: ${c.controlHover};`)}
${rule('.message-notification-group .message', `background-color: ${over(tile, c.popover)};`)}
${rule('.message-notification-group .message:hover', `background-color: ${over(c.controlHover, c.popover)};`)}
${rule('.message:second-in-stack', `background-color: ${mix(over(tile, c.popover), c.popover, 0.7)}; box-shadow: none;`)}
${rule('.message:lower-in-stack', `background-color: ${mix(over(tile, c.popover), c.popover, 0.45)}; box-shadow: none;`)}
${rule('.notification-banner', 'margin: 8px 14px;')}
${rule('.notification-banner, .notification-banner .message', `border-radius: 20px; background-color: ${withAlpha(c.popover, 0.97)}; color: ${c.fg}; border: none; box-shadow: 0 6px 20px rgba(0,0,0,${dark ? 0.3 : 0.12});`)}
${opts.glass ? rule('.notification-banner.super-g-glassed, .notification-banner.super-g-glassed .message', 'background-color: transparent; box-shadow: none;') : ''}
${opts.glass ? rule('.notification-banner.super-g-glassed:hover, .notification-banner.super-g-glassed .message:hover', `background-color: ${withAlpha(c.fg, dark ? 0.06 : 0.04)};`) : ''}
${rule('.notification-banner .message-title, .notification-banner .message-body', `color: ${c.fg};`)}
${rule('.events-button, .world-clocks-button, .weather-button', `border-radius: 16px; background-color: ${tile}; color: ${c.fg};`)}

${rule('.modal-dialog', 'border-radius: 24px;')}
${rule('.modal-dialog-linked-button', 'border-radius: 999px;')}
${rule('.switcher-list, .workspace-switcher', 'border-radius: 24px;')}
${rule('.switcher-list .item-box', `border-radius: 16px; background-color: transparent; box-shadow: none; color: ${c.fg};`)}
${rule('.switcher-list .item-box:hover', `background-color: ${withAlpha(c.fg, dark ? 0.08 : 0.06)};`)}
${rule('.switcher-list .item-box:outlined', `background-color: transparent; box-shadow: inset 0 0 0 1px ${withAlpha(c.fg, 0.3)} !important;`)}
${rule('.switcher-list .item-box:selected, .switcher-list .item-box:focus', `background-color: ${withAlpha(c.accent, dark ? 0.42 : 0.3)}; box-shadow: inset 0 0 0 2px ${withAlpha(c.accent, 0.85)} !important; color: ${c.fg};`)}
${rule('.osd-window', 'border-radius: 999px;')}

${opts.overviewGlass ? `${rule('.overview-tile, .grid-search-result, .app-folder, .list-search-result, .search-statustext', `color: ${c.fg}; text-shadow: none;`)}
${rule('.overview-tile .overview-icon, .app-folder .overview-icon', `text-shadow: none; icon-shadow: none;`)}
${tileStates('.overview-tile')}
${rule('.overview-tile:focus', `box-shadow: inset 0 0 0 2px ${withAlpha(c.accent, 0.85)} !important;`)}
${tileStates('.app-folder')}
${rule('.page-indicator .page-indicator-icon', `background-color: ${c.fg};`)}
${rule('.page-navigation-arrow', `background-color: ${withAlpha(c.fg, 0.12)}; color: ${c.fg};`)}` : ''}
${rule('.app-folder', `background-color: ${withAlpha(c.fg, dark ? 0.1 : 0.07)}; color: ${c.fg}; box-shadow: inset 0 0 0 1px ${withAlpha(c.fg, 0.08)}; border-radius: 26px;`)}
${rule('.app-folder:hover, .app-folder:focus', `background-color: ${withAlpha(c.fg, dark ? 0.16 : 0.12)};`)}
${rule('.app-folder-dialog', `background-color: ${opts.glass ? 'transparent' : withAlpha(c.window, 0.94)}; color: ${c.fg}; border-radius: 32px; border: none; box-shadow: ${opts.glass ? 'none' : `inset 0 0 0 1px ${withAlpha(c.fg, 0.08)}`};`)}
${opts.glass ? rule('.app-folder-dialog-container', 'background-color: transparent;') : ''}
${rule('.app-folder-dialog .icon-button, .app-folder-dialog .icon-button StIcon', `color: ${c.fg};`)}
${rule('.app-folder-dialog .icon-button', `background-color: ${tile}; border: none; box-shadow: none;`)}
${rule('.app-folder-dialog .icon-button:hover, .app-folder-dialog .icon-button:focus', `background-color: ${c.controlHover}; box-shadow: none !important;`)}
${rule('.app-folder-dialog .icon-button:checked', `background-color: ${c.accent}; color: ${c.accentFg};`)}
${rule('.app-folder-dialog .folder-name-entry', `color: ${c.fg}; background-color: ${tile};`)}
${rule('.app-folder-dialog .overview-tile, .app-folder-dialog .folder-name-label', `color: ${c.fg}; text-shadow: none;`)}
${rule('.spotlight-entry, .spotlight-entry:focus, .spotlight-entry:hover', `background-color: transparent; border: none; box-shadow: none; color: ${c.fg};`)}
${rule('.spotlight-entry StLabel.hint-text', `color: ${withAlpha(c.fg, 0.55)};`)}
${rule('.window-caption', `background-color: ${withAlpha(c.popover, 0.92)}; color: ${c.fg}; border-radius: 999px; box-shadow: inset 0 0 0 1px ${c.hairline};`)}
${rule('.search-entry', `background-color: ${withAlpha(c.window, dark ? 0.55 : 0.6)}; color: ${c.fg}; border-radius: 999px; border: none; box-shadow: inset 0 0 0 1px ${c.hairline};`)}
${rule('.search-entry:focus, .search-entry:hover', `background-color: ${withAlpha(c.window, dark ? 0.7 : 0.78)}; color: ${c.fg};`)}
${rule('.search-entry:focus', `box-shadow: inset 0 0 0 2px ${withAlpha(c.accent, 0.6)};`)}
${rule('.search-entry StLabel, .search-entry .clutter-text', `color: ${c.fg};`)}
${rule('.search-section-content', `background-color: ${withAlpha(c.window, dark ? 0.62 : 0.72)}; color: ${c.fg}; border-radius: 22px; border: none; box-shadow: inset 0 0 0 1px ${withAlpha(c.fg, 0.08)};`)}
${rule('.list-search-result, .list-search-result-content, .list-search-result-title, .search-provider-icon, .list-search-provider-details, .list-search-provider-details StLabel', `color: ${c.fg};`)}
${rule('.list-search-result-description, .list-search-provider-details .list-search-provider-details-count', `color: ${withAlpha(c.fg, 0.68)};`)}
${tileStates('.list-search-result')}
${tileStates('.search-provider-icon')}
${tileStates('.grid-search-result')}
${rule('.grid-search-result, .grid-search-result StLabel', `color: ${c.fg};`)}
${rule('.search-entry .search-entry-icon, .search-entry StLabel.hint-text', `color: ${c.fgMuted};`)}
`;
}

/* --------------------------------------------------------------- Theme -- */

export function gtkThemeIndex(name) {
    return `[Desktop Entry]
Type=X-GNOME-Metatheme
Name=${name}
Comment=Generated by super-g (adw-gtk3 base)
Encoding=UTF-8

[X-GNOME-Metatheme]
GtkTheme=${name}
`;
}
