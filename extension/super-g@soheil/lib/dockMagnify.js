// SPDX-License-Identifier: GPL-3.0-or-later
// Apple-style dock magnification for the dock engine (Dash to Dock).
// Runs per frame on transforms only, never touching layout: icons follow a
// cosine bell around the pointer and grow from their base edge, neighbours
// slide apart so the icon under the pointer stays under it, and the glass
// stretches with the row. Every value eases towards its target with the frame
// time, so the motion stays smooth however the pointer events arrive.
// The approach follows Dhruva's magnifier by NarkAgni (GPL-3.0).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Share of the distance covered per 60 Hz frame.
const FOLLOW = 0.3;
const SETTLE = 0.2;
const FRAME_MS = 1000 / 60;
const DONE = 0.002;
// How far past the row's ends the wave fades out, in slots.
const END_FADE = 0.9;
// How long a changed row gets to finish animating before it's measured again.
const RESETTLE_MS = 350;

const approach = (from, to, factor) =>
    Math.abs(to - from) < DONE ? to : from + (to - from) * factor;

const isItem = actor =>
    actor.has_style_class_name?.('dash-item-container') || actor.has_style_class_name?.('dash-separator');

export class DockMagnifier {
    constructor(module, dockExt) {
        this._module = module;
        this._dockExt = dockExt;
        this._docks = new Map();
    }

    get _enabled() {
        const s = this._module.settings;
        const on = s.get_boolean('dock-magnify') && !s.get_boolean('reduce-motion') &&
            St.Settings.get().enable_animations;
        // One line in the journal says whether the wave runs, and if not why.
        if (this._reported !== on) {
            this._reported = on;
            console.log(`super-g: dock magnification ${on ? 'active' : 'off'} ` +
                `(setting ${s.get_boolean('dock-magnify')}, reduce-motion ${s.get_boolean('reduce-motion')}, ` +
                `animations ${St.Settings.get().enable_animations})`);
        }
        return on;
    }

    enable() {
        const manager = this._dockExt.dockManager;
        this._readyId = manager?.connect('docks-ready', () => this._attachAll());
        // Pointer events reach the stage however the dock's actors handle them.
        this._stageId = global.stage.connect('motion-event', (_s, event) => {
            const [x, y] = event.get_coords();
            for (const state of this._docks.values())
                this._onMotion(state, x, y);
            return Clutter.EVENT_PROPAGATE;
        });
        this._attachAll();
    }

    disable() {
        global.stage.disconnect(this._stageId);
        this._stageId = 0;
        if (this._readyId)
            this._dockExt.dockManager?.disconnect(this._readyId);
        this._readyId = 0;
        this._detachAll();
    }

    _detachAll() {
        for (const state of [...this._docks.values()])
            this._detach(state);
    }

    _attachAll() {
        this._detachAll();
        for (const dock of this._dockExt.dockManager?._allDocks ?? []) {
            if (dock.dash?._box)
                this._attach(dock);
        }
    }

    _attach(dock) {
        const dash = dock.dash;
        const state = {
            dock, dash, active: false, slots: null, presence: 0, values: new Map(), watched: [],
            vertical: !(dash._isHorizontal ?? true),
            timeline: new Clutter.Timeline({actor: dash, duration: 1000, repeat_count: -1}),
        };
        state.timeline.connect('new-frame', () => this._module.guard(() => this._frame(state)));
        // The row changed: measure it again next time the pointer comes in.
        for (const box of [dash._box, dash._box.get_parent()].filter(Boolean)) {
            state.watched.push([box, box.connect('child-added', () => this._invalidate(state))],
                [box, box.connect('child-removed', () => this._invalidate(state))]);
        }
        this._docks.set(dock, state);
    }

    _detach(state) {
        for (const [obj, id] of state.watched)
            obj.disconnect(id);
        this._restAll(state);
        state.timeline = null;
        this._docks.delete(state.dock);
    }

    // The row changed under the pointer: pick the wave up again once it settled.
    _invalidate(state) {
        const wasActive = state.active;
        if (wasActive)
            this._restAll(state);
        state.slots = null;
        if (wasActive) {
            this._module.later(`dock-remeasure-${state.dash}`, RESETTLE_MS, () => {
                const [x, y] = global.get_pointer();
                if (this._docks.has(state.dock) && this._enabled && this._overDock(state, x, y))
                    this.start(state.dock);
            });
        }
    }

    // Nothing between the icons and the dock may clip what grows past it.
    _unclip(state) {
        if (state.clipped)
            return;
        state.clipped = [];
        for (let a = state.dash._box; a && a !== state.dock.get_parent(); a = a.get_parent()) {
            state.clipped.push([a, a.clip_to_allocation, 'clip_to_view' in a ? a.clip_to_view : null]);
            a.clip_to_allocation = false;
            if ('clip_to_view' in a)
                a.clip_to_view = false;
        }
    }

    _reclip(state) {
        for (const [a, alloc, view] of state.clipped ?? []) {
            a.clip_to_allocation = alloc;
            if (view !== null)
                a.clip_to_view = view;
        }
        state.clipped = null;
    }

    // Every item along the dock's axis, wherever the engine keeps it: the apps
    // button, the app icons, separators, Trash and mounts.
    _items(state) {
        const found = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (child instanceof St.ScrollBar || !child.visible)
                    continue;
                if (isItem(child))
                    found.push(child);
                else
                    walk(child);
            }
        };
        walk(state.dash);
        return found;
    }

    // Icons that are not there yet (or are leaving) keep no room in the row.
    _measure(state) {
        const {vertical} = state;
        const slots = this._items(state).map(actor => {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            return {
                actor,
                center: vertical ? y + h / 2 : x + w / 2,
                size: vertical ? h : w,
                zooms: actor.has_style_class_name('dash-item-container'),
                visual: this._visual(actor),
                dots: this._dots(actor),
            };
        }).filter(slot => slot.size > 0).sort((a, b) => a.center - b.center);
        const first = slots.find(s => s.zooms);
        state.iconSize = first ? first.size : 64;
        state.slots = slots;
    }

    // What actually scales: the item container's size follows its scale (GNOME
    // animates additions that way) and Flourish resets the app icon's own
    // transforms, so the widget inside the icon carries it.
    _visual(item) {
        const child = item.child ?? item.get_first_child?.();
        return child?.get_first_child?.() ?? child ?? null;
    }

    // The running indicator keeps its size and place under a grown icon.
    _dots(item) {
        const found = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (child.has_style_class_name?.('app-grid-running-dot') ||
                    child.constructor.name.includes('RunningIndicator') || child._isRunningIndicator)
                    found.push(child);
                else
                    walk(child);
            }
        };
        walk(item);
        return found;
    }

    _inside(state, x, y) {
        const bg = state.dash._background ?? state.dash;
        if (!bg.mapped)
            return false;
        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        const pad = END_FADE * (state.iconSize ?? 64);
        const side = state.dock._position;
        // Keep the wave over the risen icons; it starts only on the dock.
        const rise = state.active ? (this._scale() - 1) * (state.iconSize ?? 64) : 0;
        if (state.vertical) {
            return y >= by - pad && y <= by + bh + pad &&
                x >= bx - (side === St.Side.RIGHT ? rise : 0) && x <= bx + bw + (side === St.Side.LEFT ? rise : 0);
        }
        return x >= bx - pad && x <= bx + bw + pad &&
            y >= by - (side === St.Side.BOTTOM ? rise : 0) && y <= by + bh + (side === St.Side.TOP ? rise : 0);
    }

    _scale() {
        return this._module.settings.get_double('dock-magnify-scale');
    }

    _overDock(state, x, y) {
        const bg = state.dash._background ?? state.dash;
        if (!bg.mapped)
            return false;
        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    }

    _onMotion(state, x, y) {
        if (!state.active && this._enabled && this._overDock(state, x, y))
            this.start(state.dock);
    }

    start(dock) {
        const state = this._docks.get(dock);
        if (!state || state.active)
            return;
        this._measure(state);
        if (!state.slots.length)
            return;
        this._unclip(state);
        const {vertical} = state;
        const side = state.dock._position;
        for (const slot of state.slots) {
            slot.actor.remove_all_transitions();
            slot.visual?.remove_all_transitions();
            slot.visual?.set_pivot_point(
                vertical ? (side === St.Side.RIGHT ? 1 : 0) : 0.5,
                vertical ? 0.5 : (side === St.Side.TOP ? 0 : 1));
            for (const dot of slot.dots)
                dot.set_pivot_point(0.5, side === St.Side.TOP ? 0 : 1);
            state.values.set(slot.actor, {scale: 1, shift: 0});
        }
        // Whole-row growth is about zoom x radius (the bell's area), all of it
        // on one side at the row's ends.
        const most = (this._scale() - 1) * state.iconSize * this._module.settings.get_double('dock-magnify-reach') +
            state.iconSize / 2;
        state.dash._background?._glassLayer?.setRoom(vertical
            ? {top: most, bottom: most} : {left: most, right: most});
        state.active = true;
        state.lastFrame = Date.now();
        state.presence = 0;
        state.timeline.start();
    }

    _frame(state) {
        const now = Date.now();
        const dt = Math.max(1, Math.min(64, now - state.lastFrame));
        state.lastFrame = now;
        const [x, y] = global.get_pointer();
        const inside = this._enabled && !state.dock._isHiding?.() && this._inside(state, x, y);
        const cursor = state.vertical ? y : x;
        const {slots} = state;

        const follow = 1 - (1 - FOLLOW) ** (dt / FRAME_MS);
        const settle = 1 - (1 - SETTLE) ** (dt / FRAME_MS);

        // Targets: the bell around the pointer, fading past the row's ends.
        const zoom = this._scale() - 1;
        const radius = state.iconSize * this._module.settings.get_double('dock-magnify-reach');
        const firstCenter = slots[0].center, lastCenter = slots[slots.length - 1].center;
        const past = Math.max(firstCenter - cursor, cursor - lastCenter, 0) / (state.iconSize * END_FADE);
        let target = inside ? Math.max(0, 1 - past) : 0;
        target = target * target * (3 - 2 * target);
        state.presence = approach(state.presence, target, inside ? follow : settle);

        const scales = slots.map(slot => {
            if (!slot.zooms)
                return 1;
            const d = Math.abs(cursor - slot.center);
            const bell = d >= radius ? 0 : (Math.cos(d / radius * Math.PI) + 1) / 2;
            return 1 + zoom * bell * target;
        });

        // Centres pushed apart by how much each neighbour grew. Stay anchored
        // at the pointer's own place in the row, so what's under it stays.
        const centers = [slots[0].center];
        for (let i = 1; i < slots.length; i++) {
            const gap = slots[i].center - slots[i - 1].center;
            const grown = (slots[i - 1].size * (scales[i - 1] - 1) + slots[i].size * (scales[i] - 1)) / 2;
            centers.push(centers[i - 1] + gap + grown);
        }
        const mapped = this._mapThrough(slots.map(s => s.center), centers, cursor);
        const offset = inside ? (cursor - mapped) * target : cursor - mapped;

        // Ease and apply.
        const factor = inside ? follow : settle;
        let moving = Math.abs(state.presence - target) > DONE;
        let [low, high] = [Infinity, -Infinity];
        let [restLow, restHigh] = [Infinity, -Infinity];
        slots.forEach((slot, i) => {
            const value = state.values.get(slot.actor);
            if (!value || !slot.actor.get_parent())
                return;
            const wantScale = scales[i];
            const wantShift = target > 0 ? centers[i] + offset - slot.center : 0;
            value.scale = approach(value.scale, wantScale, factor);
            value.shift = approach(value.shift, wantShift, factor);
            if (value.scale !== wantScale || Math.abs(value.shift - wantShift) > 0.1)
                moving = true;
            this._apply(state, slot, value);
            const half = slot.size * value.scale / 2;
            low = Math.min(low, slot.center + value.shift - half);
            high = Math.max(high, slot.center + value.shift + half);
            restLow = Math.min(restLow, slot.center - slot.size / 2);
            restHigh = Math.max(restHigh, slot.center + slot.size / 2);
        });
        const [before, after] = [Math.max(0, restLow - low), Math.max(0, high - restHigh)];
        state.dash._background?._glassLayer?.setStretch(state.vertical
            ? {top: before, bottom: after} : {left: before, right: after});

        if (!inside && !moving)
            this._restAll(state);
    }

    _mapThrough(rest, moved, value) {
        const n = rest.length;
        if (value <= rest[0])
            return moved[0] + (value - rest[0]);
        if (value >= rest[n - 1])
            return moved[n - 1] + (value - rest[n - 1]);
        for (let i = 1; i < n; i++) {
            if (value <= rest[i]) {
                const t = (value - rest[i - 1]) / (rest[i] - rest[i - 1]);
                return moved[i - 1] + (moved[i] - moved[i - 1]) * t;
            }
        }
        return value;
    }

    _apply(state, slot, {scale, shift}) {
        const {actor, visual} = slot;
        if (visual) {
            visual.scale_x = scale;
            visual.scale_y = scale;
        }
        if (state.vertical)
            actor.translation_y = shift;
        else
            actor.translation_x = shift;
        const inverse = 1 / scale;
        for (const dot of slot.dots) {
            dot.scale_x = inverse;
            dot.scale_y = inverse;
        }
    }

    _restAll(state) {
        state.timeline?.stop();
        for (const slot of state.slots ?? []) {
            if (!slot.actor.get_parent())
                continue;
            this._apply(state, slot, {scale: 1, shift: 0});
        }
        state.dash._background?._glassLayer?.setRoom({});
        state.active = false;
        state.values.clear();
        // The row may have changed while it was stretched.
        state.slots = null;
        this._reclip(state);
    }
}
