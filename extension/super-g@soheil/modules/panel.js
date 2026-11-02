// SPDX-License-Identifier: GPL-3.0-or-later
// Top bar: floating / islands / adaptive styles, height, glass, clock format,
// grouped status pill, hidden accessibility icon and start-on-desktop.
// The focused-app title comes from the windows (Kiwi) engine; this module
// turns off that engine's own panel styling so the two don't fight.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import {LiveStylesheet, engineSettings, engineChildSettings} from '../lib/stylesheet.js';
import {resolve} from '../lib/themeGen.js';
import {withAlpha} from '../lib/color.js';
import {handOver, handBack} from '../lib/engine.js';
import {glassAlpha} from '../lib/glass.js';
import {stripLuminance, currentWallpaperUri, currentImage} from '../lib/wallpaper.js';
import {luminance, onColor, mix} from '../lib/color.js';

const IFACE = 'org.gnome.desktop.interface';
const SAVED = `${Files.STATE}/panel-original.json`;
// The parts of Just Perfection in use (hidden accessibility icon, start on
// the desktop) are covered here.
const REPLACES = ['just-perfection-desktop@just-perfection'];
const GAP = 6;
const SOLID_CLASS = 'super-g-panel-solid';
const WALLPAPER_CHECK_MS = 5 * 60 * 1000;
// The bar's boxes and the part of its width each covers.
const BOXES = [['panelLeft', 0, 0.22], ['panelCenter', 0.38, 0.62], ['panelRight', 0.72, 1]];

const boxRules = (box, fg) => `${box} .panel-button, ${box} .panel-button:hover, ${box} .panel-button:active,
${box} .panel-button:checked, ${box} .panel-button:focus { color: ${fg}; }
${box} .panel-button .system-status-icon, ${box} .panel-button StIcon { color: ${fg}; }
${box} .workspace-dot { background-color: ${fg}; }
${box} .kiwi-input-themed StLabel { border-color: ${fg}; color: ${fg}; }
${box} .kiwi-input-en StLabel { background-color: ${fg}; color: ${onColor(fg)}; }`;
const STATUS_CLASS = 'super-g-status';
// Kiwi panel features that would restyle the bar underneath us.
const KIWI_OFF = {'panel-styling': false, 'panel-transparency': false, 'panel-blur': false, 'panel-opaque-on-window': false};

export default class PanelModule extends Module {
    enable() {
        this._iface = new Gio.Settings({schema_id: IFACE});
        this._tokens = JSON.parse(Files.readText(`${this.ext.path}/tokens.json`));
        this._sheet = new LiveStylesheet('panel');
        this._kiwi = engineSettings(this.ext.path, 'windows');
        this._blurPanel = engineChildSettings(this.ext.path, 'blur', 'panel');
        this._windowSignals = new Map();
        handOver(this.name, REPLACES);
        this._save();

        this.connect(this.settings, 'changed', () => this.later('apply', 120, () => this._apply()));
        this.connect(this._iface, 'changed::color-scheme', () => this._apply());
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this.connect(this._bg, 'changed', () => this.later('apply', 120, () => this._apply()));

        if (Main.layoutManager._startingUp && this.settings.get_boolean('startup-desktop')) {
            this.connect(Main.layoutManager, 'startup-complete', () => Main.overview.hide());
        }
        this._apply();
        this._watchWallpaperClock();
    }

    // A timed wallpaper changes with no settings signal.
    _watchWallpaperClock() {
        this.later('wallpaper-clock', WALLPAPER_CHECK_MS, () => {
            const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
            const image = currentImage(currentWallpaperUri(dark));
            if (this._wallpaperImage && image !== this._wallpaperImage)
                this._apply();
            this._wallpaperImage = image;
            this._watchWallpaperClock();
        });
    }

    disable() {
        this.cleanup();
        this._stopTracking();
        this._sheet.clear();
        Main.panel.remove_style_class_name(SOLID_CLASS);
        Main.panel.statusArea.quickSettings?.remove_style_class_name(STATUS_CLASS);
        this._setA11yVisible(true);
        this._restore();
        handBack(this.name, REPLACES);
    }

    /* ---------------------------------------------------- applying -- */

    _apply() {
        const s = this.settings;
        const style = s.get_string('panel-style');
        const height = s.get_int('panel-height');
        Main.panel.statusArea.quickSettings?.add_style_class_name(STATUS_CLASS);

        this._sheet.set(this._css(style, height, s.get_string('panel-status-style')));
        this._setA11yVisible(!s.get_boolean('hide-accessibility'));
        this._applyClock();
        this._applyBlur(style);
        for (const [key, value] of Object.entries(KIWI_OFF)) {
            if (this._kiwi?.settings_schema.has_key(key) && this._kiwi.get_boolean(key) !== value)
                this._kiwi.set_boolean(key, value);
        }

        if (style === 'adaptive' && s.get_boolean('panel-adaptive-solid'))
            this._startTracking();
        else
            this._stopTracking();
    }

    _css(style, height, status) {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        const opts = {
            palette: this.settings.get_string('palette'),
            accent: this.settings.get_string('accent'),
        };
        const c = {...resolve(this._tokens, opts, dark)};
        const themeFg = c.fg;
        // A wallpaper can be light on one side of the bar and dark on the
        // other, so each of the bar's three boxes picks its own colour.
        const boxFg = BOXES.map(([id, x0, x1]) => [id, this._autoForeground(c, style, dark, x0, x1)]);
        c.fg = boxFg[2][1];
        // The bar blurs through the clear pipeline (lib/blurSetup.js), so a
        // moderate tint is enough to carry the palette colour.
        // With Super G glass on the bar, the glass layer is the surface.
        const glassOn = this.settings.get_boolean('panel-glass') && this.settings.get_boolean('module-glass');
        const glass = glassOn ? 'transparent' : withAlpha(c.window, dark ? 0.78 : 0.8);
        const edge = dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)';
        const pill = withAlpha(c.fg, dark ? 0.1 : 0.07);
        const pillHover = withAlpha(c.fg, dark ? 0.16 : 0.12);
        const P = '#uiGroup #panel';
        // Buttons sit inset in a roomy bar; a low one gives them all of it, or
        // their text no longer fits (a line takes about 28 px with the clock's box).
        const inset = Math.max(0, Math.min(4, Math.floor((height - 28) / 2)));

        const base = `
${P} { height: ${height}px; color: ${c.fg}; font-weight: 500; font-size: ${height < 28 ? 9.5 : height < 32 ? 10 : 10.5}pt;
  transition-duration: 250ms; padding: 0 ${style === 'adaptive' ? 8 : 4}px; }
${P} .panel-button { color: ${c.fg}; border-radius: 999px; -natural-hpadding: 9px; -minimum-hpadding: 6px;
  margin: ${inset}px 1px; padding-top: 0; padding-bottom: 0; }
${P} .panel-button .panel-button { margin: 0; padding: 0; background-color: transparent; box-shadow: none; -natural-hpadding: 0; -minimum-hpadding: 0; spacing: 6px; }
${P} .clock-display-box, ${P} .clock { padding: 0; margin: 0; spacing: 0; }
${P} .panel-status-indicators-box, ${P} .panel-status-menu-box { spacing: 9px; }
${P} .power-status { spacing: 3px; }
${P} .system-status-icon { icon-size: 16px; padding: 0; margin: 0; }
${P} .app-menu-icon { icon-size: 16px; }
${P} #panelActivities { -natural-hpadding: 8px; }
${P} .panel-button:hover, ${P} .panel-button:active, ${P} .panel-button:checked, ${P} .panel-button:focus {
  background-color: ${pillHover}; color: ${c.fg}; box-shadow: none; }
${P} .panel-button .system-status-icon, ${P} .panel-button StIcon { color: ${c.fg}; }
${P} .kiwi-input-themed StLabel { border: 1.5px solid ${c.fg}; color: ${c.fg}; background-color: transparent; border-radius: 5px; padding: 0 5px; font-size: 9.5pt; }
${P} .kiwi-input-en StLabel { background-color: ${c.fg}; color: ${onColor(c.fg)}; }
${P} #panelActivities { background-color: transparent; }
${P} #panelActivities:checked, ${P} #panelActivities:hover { background-color: ${pillHover}; }`;

        const statusCss = status === 'grouped'
            ? `${P} .panel-button.${STATUS_CLASS} { background-color: ${pill}; }
${P} .panel-button.${STATUS_CLASS}:hover, ${P} .panel-button.${STATUS_CLASS}:checked { background-color: ${pillHover}; }`
            : `${P} .panel-button.${STATUS_CLASS} { background-color: transparent; }`;

        let shape;
        if (style === 'islands') {
            // St takes margins from CSS, so the gaps around the bar live here
            // (and reserve the same room under it when a window is maximized).
            shape = `${P} { background-color: transparent; border: none; box-shadow: none; margin: ${GAP}px ${GAP}px ${GAP}px ${GAP}px; }
${P} .panel-button { background-color: ${glassOn ? 'transparent' : glass}; box-shadow: ${glassOn ? 'none' : `inset 0 0 0 1px ${c.hairline}`}; margin: ${inset}px 2px; }
${P} .panel-button.${STATUS_CLASS} { background-color: ${glassOn ? 'transparent' : glass}; }
${P} .panel-button:hover, ${P} .panel-button:checked, ${P} .panel-button:active { background-color: ${pillHover}; }`;
        } else if (style === 'adaptive') {
            shape = `${P} { background-color: transparent; border-radius: 0; }
${this.settings.get_boolean('panel-adaptive-solid') ? `${P}.${SOLID_CLASS} { background-color: ${c.window}; box-shadow: inset 0 -1px 0 ${c.hairline}; }
${BOXES.map(([id]) => boxRules(`${P}.${SOLID_CLASS} #${id}`, themeFg)).join('\n')}` : ''}`;
        } else {
            // The glass shader draws its own rim; a CSS rim on top doubles the edge.
            const rim = glassOn ? 'none' : `inset 0 1px 0 ${edge}, inset 0 0 0 1px ${c.hairline}`;
            shape = `${P} { background-color: ${glass}; border-radius: ${Math.round(height * 0.42)}px; box-shadow: ${rim};
  margin: ${GAP}px ${GAP}px ${GAP}px ${GAP}px; }`;
        }
        const boxes = boxFg.map(([id, fg]) => boxRules(`${P} #${id}`, fg)).join('\n');
        return `/* Generated by super-g: top bar. */${base}\n${statusCss}\n${boxes}\n${shape}\n`;
    }

    // Text picks whichever of two strong colours reads best over what is really
    // behind it: the wallpaper under that part of the bar, through the bar's own
    // tint. Mixing happens in gamma space, as the screen does it.
    _autoForeground(c, style, dark, x0, x1) {
        const wall = stripLuminance(currentWallpaperUri(dark), 'top', 0.04, x0, x1);
        if (wall === null)
            return c.fg;
        const glassOn = this.settings.get_boolean('panel-glass') && this.settings.get_boolean('module-glass');
        const alpha = glassOn ? glassAlpha(c, this.settings) : style === 'adaptive' ? 0 : 0.8;
        const gamma = alpha * luminance(c.window) ** (1 / 2.2) + (1 - alpha) * wall ** (1 / 2.2);
        const behind = gamma ** 2.2;
        const pal = this._tokens.palettes[this.settings.get_string('palette')] ?? this._tokens.palettes.catppuccin;
        const darkText = mix(pal.light.fg, '#000000', 0.45);
        const lightText = mix(pal.dark.fg, '#ffffff', 0.45);
        const contrast = text => {
            const l = luminance(text);
            return (Math.max(l, behind) + 0.05) / (Math.min(l, behind) + 0.05);
        };
        return contrast(darkText) >= contrast(lightText) ? darkText : lightText;
    }

    _applyClock() {
        const s = this.settings;
        this._setIface('clock-show-weekday', s.get_boolean('clock-weekday'));
        this._setIface('clock-show-date', s.get_boolean('clock-date'));
        const format = s.get_boolean('clock-24h') ? '24h' : '12h';
        if (this._iface.get_string('clock-format') !== format)
            this._iface.set_string('clock-format', format);
    }

    _applyBlur(style) {
        // Only the legacy Blur my Shell engine needs its panel blur set.
        if (!this._blurPanel || !this.settings.get_boolean('module-blur'))
            return;
        const want = this.settings.get_boolean('panel-glass') && style !== 'adaptive';
        if (this._blurPanel.get_boolean('blur') !== want)
            this._blurPanel.set_boolean('blur', want);
        if (this._blurPanel.get_boolean('override-background'))
            this._blurPanel.set_boolean('override-background', false);
    }

    _setA11yVisible(visible) {
        const a11y = Main.panel.statusArea.a11y;
        if (a11y)
            a11y.container.visible = visible;
    }

    _setIface(key, value) {
        if (this._iface.get_boolean(key) !== value)
            this._iface.set_boolean(key, value);
    }

    /* ------------------------------------------ adaptive: windows -- */

    // With panel-adaptive-solid on, the bar takes the window colour while a
    // window on the primary monitor touches it. Off (the default) it stays
    // see-through, showing the wallpaper: windows stop below the bar.
    _startTracking() {
        if (this._tracking)
            return;
        this._tracking = true;
        this.connect(global.display, 'window-created', (_d, win) => this._watch(win));
        this.connect(global.workspace_manager, 'active-workspace-changed', () => this._queueCheck());
        this.connect(Main.overview, 'showing', () => this._setSolid(false));
        this.connect(Main.overview, 'hidden', () => this._queueCheck());
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
        this._queueCheck();
    }

    _stopTracking() {
        for (const [win, ids] of this._windowSignals)
            ids.forEach(id => win.disconnect(id));
        this._windowSignals.clear();
        this._tracking = false;
        Main.panel.remove_style_class_name(SOLID_CLASS);
    }

    _watch(win) {
        if (this._windowSignals.has(win))
            return;
        const check = () => this._queueCheck();
        const ids = ['position-changed', 'size-changed', 'notify::minimized', 'workspace-changed']
            .map(sig => win.connect(sig, check));
        ids.push(win.connect('unmanaged', () => {
            ids.forEach(id => win.disconnect(id));
            this._windowSignals.delete(win);
            check();
        }));
        this._windowSignals.set(win, ids);
        check();
    }

    _queueCheck() {
        this.later('adaptive', 60, () => this._check());
    }

    _check() {
        if (!this._tracking || Main.overview.visible)
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const monitor = Main.layoutManager.primaryMonitor;
        const edge = monitor.y + Main.panel.height + 4;
        const touching = workspace.list_windows().some(win =>
            !win.minimized && win.get_monitor() === monitor.index &&
            win.get_window_type() === Meta.WindowType.NORMAL &&
            win.get_frame_rect().y <= edge);
        this._setSolid(touching);
    }

    _setSolid(solid) {
        if (solid)
            Main.panel.add_style_class_name(SOLID_CLASS);
        else
            Main.panel.remove_style_class_name(SOLID_CLASS);
    }

    /* ------------------------------------------------ saved values -- */

    _save() {
        if (Files.readText(SAVED))
            return;
        const saved = {iface: {}, kiwi: {}, blurPanel: {}};
        for (const k of ['clock-show-weekday', 'clock-show-date'])
            saved.iface[k] = this._iface.get_boolean(k);
        saved.iface['clock-format'] = this._iface.get_string('clock-format');
        for (const k of Object.keys(KIWI_OFF)) {
            if (this._kiwi?.settings_schema.has_key(k))
                saved.kiwi[k] = this._kiwi.get_boolean(k);
        }
        if (this._blurPanel) {
            saved.blurPanel.blur = this._blurPanel.get_boolean('blur');
            saved.blurPanel['override-background'] = this._blurPanel.get_boolean('override-background');
        }
        Files.writeText(SAVED, JSON.stringify(saved, null, 2));
    }

    _restore() {
        const text = Files.readText(SAVED);
        if (!text)
            return;
        const saved = JSON.parse(text);
        for (const [k, v] of Object.entries(saved.iface ?? {}))
            typeof v === 'boolean' ? this._iface.set_boolean(k, v) : this._iface.set_string(k, v);
        for (const [k, v] of Object.entries(saved.kiwi ?? {}))
            this._kiwi?.set_boolean(k, v);
        for (const [k, v] of Object.entries(saved.blurPanel ?? {}))
            this._blurPanel?.set_boolean(k, v);
        Files.remove(SAVED);
    }
}
