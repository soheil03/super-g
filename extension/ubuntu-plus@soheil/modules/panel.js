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
import {stripLuminance, currentWallpaperUri} from '../lib/wallpaper.js';
import {luminance} from '../lib/color.js';

const IFACE = 'org.gnome.desktop.interface';
const SAVED = `${Files.STATE}/panel-original.json`;
// The parts of Just Perfection in use (hidden accessibility icon, start on
// the desktop) are covered here.
const REPLACES = ['just-perfection-desktop@just-perfection'];
const GAP = 6;
const SOLID_CLASS = 'ubuntu-plus-panel-solid';
const STATUS_CLASS = 'ubuntu-plus-status';
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

        if (style === 'adaptive')
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
        c.fg = this._autoForeground(c, style, dark);
        // The bar blurs through the clear pipeline (lib/blurSetup.js), so a
        // moderate tint is enough to carry the palette colour.
        // With Ubuntu Plus glass on the bar, the glass layer is the surface.
        const glassOn = this.settings.get_boolean('panel-glass') && this.settings.get_boolean('module-glass');
        const glass = glassOn ? 'transparent' : withAlpha(c.window, dark ? 0.78 : 0.8);
        const edge = dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)';
        const pill = withAlpha(c.fg, dark ? 0.1 : 0.07);
        const pillHover = withAlpha(c.fg, dark ? 0.16 : 0.12);
        const P = '#uiGroup #panel';

        const base = `
${P} { height: ${height}px; color: ${c.fg}; font-weight: 600; transition-duration: 250ms; }
${P} .panel-button { color: ${c.fg}; border-radius: 999px; -natural-hpadding: 10px; -minimum-hpadding: 6px;
  margin: 0; padding-top: 0; padding-bottom: 0; }
${P} .panel-button:hover, ${P} .panel-button:active, ${P} .panel-button:checked, ${P} .panel-button:focus {
  background-color: ${pillHover}; color: ${c.fg}; box-shadow: none; }
${P} .panel-button .system-status-icon, ${P} .panel-button StIcon { color: ${c.fg}; }
${P} .kiwi-input-themed StLabel { border: 1.5px solid ${c.fg}; color: ${c.fg}; background-color: transparent; border-radius: 5px; }
${P} .kiwi-input-en StLabel { background-color: ${c.fg}; color: ${c.window}; }
${P} #panelActivities { background-color: transparent; }
${P} #panelActivities:checked, ${P} #panelActivities:hover { background-color: ${pillHover}; }`;

        const statusCss = status === 'grouped'
            ? `${P} .panel-button.${STATUS_CLASS} { background-color: ${pill}; }
${P} .panel-button.${STATUS_CLASS}:hover, ${P} .panel-button.${STATUS_CLASS}:checked { background-color: ${pillHover}; }`
            : `${P} .panel-button.${STATUS_CLASS} { background-color: transparent; }`;

        let shape;
        if (style === 'islands') {
            // St takes margins from CSS, so the gap around the bar lives here.
            shape = `${P} { background-color: transparent; border: none; margin: ${GAP}px ${GAP}px 0 ${GAP}px; }
${P} .panel-button { background-color: ${glass}; box-shadow: inset 0 0 0 1px ${c.hairline}; margin-left: 2px; margin-right: 2px; }`;
        } else if (style === 'adaptive') {
            shape = `${P} { background-color: transparent; border-radius: 0; }
${P}.${SOLID_CLASS} { background-color: ${c.window}; box-shadow: inset 0 -1px 0 ${c.hairline}; }`;
        } else {
            shape = `${P} { background-color: ${glass}; border-radius: 12px; box-shadow: inset 0 1px 0 ${edge}, inset 0 0 0 1px ${c.hairline};
  margin: ${GAP}px ${GAP}px 0 ${GAP}px; }`;
        }
        return `/* Generated by ubuntu-plus: top bar. */${base}\n${statusCss}\n${shape}\n`;
    }

    // Over see-through bars (glass, adaptive) the text colour follows what's
    // behind: the wallpaper strip under the bar, mixed with the glass tint.
    _autoForeground(c, style, dark) {
        const glassOn = this.settings.get_boolean('panel-glass') && this.settings.get_boolean('module-glass');
        const seeThrough = style === 'adaptive' || style === 'islands' || glassOn;
        if (!seeThrough)
            return c.fg;
        const wall = stripLuminance(currentWallpaperUri(dark), 'top', 0.04);
        if (wall === null)
            return c.fg;
        const tint = style === 'adaptive' ? 0 : this.settings.get_double('glass-tint');
        const behind = tint * luminance(c.window) + (1 - tint) * wall;
        const pal = this._tokens.palettes[this.settings.get_string('palette')] ?? this._tokens.palettes.catppuccin;
        return behind > 0.36 ? pal.light.fg : pal.dark.fg;
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

    // The bar turns solid while a window on the primary monitor touches it.
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
