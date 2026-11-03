// SPDX-License-Identifier: GPL-3.0-or-later
// Apple-style dock magnification for the dock engine (Dash to Dock).
// Runs per frame on transforms only, never touching layout: icons follow a
// cosine bell around the pointer and grow from their base edge, neighbours
// slide apart so the icon under the pointer stays under it, and the glass
// stretches with the row. Every value eases towards its target with the frame
// time, so the motion stays smooth however the pointer events arrive.
// The approach follows Dhruva's magnifier by NarkAgni (GPL-3.0).

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
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
// A press on the dock that hasn't moved this far since keeps the row settled.
const SEATED_SLOP = 6;
// While nothing moves, frames stop and this watches the pointer instead.
const IDLE_POLL_MS = 80;
// The running dot's distance below the icon's edge.
const DOT_DROP = 7;
// A launch: hops of this share of the icon, each lower than the last, repeating
// while the app starts, as on a Mac.
const BOUNCE_HEIGHT = 0.42;
const BOUNCE_MS = 420;
const DAMPING = 0.82;
const BOUNCE_MIN = 2;
const BOUNCE_MAX = 12;

const approach = (from, to, factor) =>
    Math.abs(to - from) < DONE ? to : from + (to - from) * factor;

const isItem = actor =>
    actor.has_style_class_name?.('dash-item-container') || actor.has_style_class_name?.('dash-separator');

export class DockMagnifier {
    constructor(module, dockExt) {
        this._module = module;
        this._dockExt = dockExt;
        this._dockSettings = module.instance.getSettings();
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
        // Captured: a clicked icon may consume the release.
        this._clickId = global.stage.connect('captured-event', (_s, event) => {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                const [x, y] = event.get_coords();
                for (const state of this._docks.values()) {
                    if (state.active && this._overDock(state, x, y))
                        state.seatedAt = [x, y];
                    this._wake(state);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._attachAll();
    }

    disable() {
        global.stage.disconnect(this._stageId);
        this._stageId = 0;
        global.stage.disconnect(this._clickId);
        this._clickId = 0;
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
            dock, dash, active: false, slots: null, presence: 0, watched: [], id: this._docks.size,
            vertical: !(dash._isHorizontal ?? true),
            timeline: new Clutter.Timeline({actor: dash, duration: 1000, repeat_count: -1}),
        };
        state.timeline.connect('new-frame', () => this._module.guard(() => this._frame(state)));
        // Icons come and go (a launch, a minimize) while the wave runs.
        const roots = [dash._box, dash._box.get_parent()].filter(Boolean);
        for (const box of roots) {
            state.watched.push([box, box.connect('child-added', () => this._rowChanged(state))],
                [box, box.connect('child-removed', () => this._rowChanged(state))]);
        }
        dash.connect('destroy', () => (state.gone = true));
        this._docks.set(dock, state);
        this._placeDots(state);
        this._hookLaunches(state);
    }

    _rowChanged(state) {
        if (state.gone)
            return;
        state.dirty = true;
        this._wake(state);
        this._module.later('dock-dots', RESETTLE_MS, () => {
            this._placeDots(state);
            if (!state.gone)
                this._hookLaunches(state);
        });
    }

    // The icon fills its box, so the box's own bottom edge is inside the art;
    // the dot belongs below it, in the dock's padding.
    _placeDots(state) {
        if (state.vertical || !this._docks.has(state.dock) || state.gone)
            return;
        const drop = state.dock._position === St.Side.TOP ? -DOT_DROP : DOT_DROP;
        for (const item of this._items(state)) {
            for (const dot of this._dots(item))
                dot.translation_y = drop;
        }
    }

    // The launch is the icon itself hopping: Flourish's launch flies a clone in
    // a layer of its own, which slips away from a row that is still settling.
    // On the instance, so it shadows Flourish's hook for dock icons only.
    _hookLaunches(state) {
        for (const item of this._items(state)) {
            const icon = item.child;
            if (!icon?.animateLaunch || icon._superGLaunch)
                continue;
            icon._superGLaunch = true;
            icon.animateLaunch = () => this._module.guard(() => this._bounce(state, item));
        }
        for (const item of this._items(state))
            this._hookLabel(item);
    }

    // A label goes over the dock and clear of the grown icon, or not at all.
    _hookLabel(item) {
        if (!item.showLabel || item._superGLabel)
            return;
        item._superGLabel = true;
        const show = item.showLabel;
        item.showLabel = () => {
            if (this._dockSettings?.get_boolean('hide-tooltip'))
                return;
            show.call(item);
            const {label} = item;
            if (label?.get_parent()) {
                label.get_parent().set_child_above_sibling(label, null);
                const visual = this._visual(item);
                const grown = visual ? (visual.scale_y - 1) * visual.height : 0;
                label.translation_y = -grown;
            }
        };
    }

    _bounce(state, item) {
        const visual = this._visual(item);
        const s = this._module.settings;
        if (!visual || visual._bouncing || !s.get_boolean('dock-launch-bounce') || !this._enabled)
            return;
        visual._bouncing = true;
        const side = state.dock._position;
        const [axis, sign] = {
            [St.Side.LEFT]: ['translation_x', 1], [St.Side.RIGHT]: ['translation_x', -1],
            [St.Side.TOP]: ['translation_y', 1],
        }[side] ?? ['translation_y', -1];
        const height = (state.vertical ? visual.width : visual.height) * BOUNCE_HEIGHT;
        const dots = this._dots(item);
        const app = item.child.app;
        let hop = 0;
        const timeline = new Clutter.Timeline({actor: visual, duration: BOUNCE_MS, repeat_count: BOUNCE_MAX - 1});
        const place = lift => {
            visual[axis] = lift * sign;
            // The dot stays on the dock.
            for (const dot of dots)
                dot[axis] = (axis === 'translation_y' ? (dot._dockDrop ?? 0) : 0) - lift * sign;
        };
        for (const dot of dots)
            dot._dockDrop = dot.translation_y;
        const stop = () => {
            timeline.stop();
            place(0);
            visual._bouncing = false;
        };
        timeline.connect('new-frame', (_t, ms) => {
            const t = ms / BOUNCE_MS;
            place(height * DAMPING ** hop * 4 * t * (1 - t));
        });
        timeline.connect('stopped', () => {
            if (visual._bouncing)
                stop();
        });
        // A hop always lands; only then is the app asked whether it's up.
        timeline.connect('completed', () => {
            hop++;
            if (hop >= BOUNCE_MIN && app?.state !== Shell.AppState.STARTING)
                stop();
        });
        timeline.start();
    }

    _detach(state) {
        if (state.gone) {
            this._docks.delete(state.dock);
            return;
        }
        for (const [obj, id] of state.watched)
            obj.disconnect(id);
        this._restAll(state);
        state.timeline = null;
        this._docks.delete(state.dock);
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

    // The list of items is walked only when the row changed; where each one
    // rests is read from its live position every frame, with our own shift taken
    // out, so an icon animating in moves the row smoothly instead of a jump.
    _measure(state) {
        const known = new Map((state.slots ?? []).map(slot => [slot.actor, slot]));
        const side = state.dock._position;
        state.slots = this._items(state).map(actor => {
            const slot = known.get(actor);
            if (slot)
                return slot;
            const fresh = {
                actor,
                zooms: actor.has_style_class_name('dash-item-container'),
                visual: this._visual(actor),
                dots: this._dots(actor),
                value: {scale: 1, shift: 0},
            };
            actor.connect('destroy', () => (fresh.dead = true));
            actor.remove_all_transitions();
            fresh.visual?.remove_all_transitions();
            fresh.visual?.set_pivot_point(
                state.vertical ? (side === St.Side.RIGHT ? 1 : 0) : 0.5,
                state.vertical ? 0.5 : (side === St.Side.TOP ? 0 : 1));
            for (const dot of fresh.dots)
                dot.set_pivot_point(0.5, side === St.Side.TOP ? 0 : 1);
            return fresh;
        });
        state.dirty = false;
    }

    _locate(state) {
        const {vertical} = state;
        const placed = [];
        for (const slot of state.slots) {
            if (slot.dead)
                continue;
            const [x, y] = slot.actor.get_transformed_position();
            const [w, h] = slot.actor.get_transformed_size();
            slot.center = vertical ? y + h / 2 - slot.value.shift : x + w / 2 - slot.value.shift;
            slot.size = vertical ? h : w;
            if (slot.size > 0)
                placed.push(slot);
        }
        placed.sort((a, b) => a.center - b.center);
        const first = placed.find(s => s.zooms);
        state.iconSize = first ? first.size : 64;
        return placed;
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
        if (state.active)
            this._wake(state);
        else if (this._enabled && this._overDock(state, x, y))
            this.start(state.dock);
    }

    _wake(state) {
        if (state.active && !state.timeline?.is_playing()) {
            state.lastFrame = Date.now();
            state.timeline.start();
        }
    }

    // Everything's at rest with the pointer on the dock: no frames, no full
    // redraws of the glass, until the pointer moves or leaves.
    _sleep(state) {
        state.timeline.stop();
        const [px, py] = global.get_pointer();
        const check = () => {
            if (!state.active || state.timeline?.is_playing())
                return;
            const [x, y] = global.get_pointer();
            // An opening menu grabs the pointer, so no event says it happened.
            const menuOpen = state.slots?.some(slot => slot.actor.child?._menu?.isOpen);
            if (x !== px || y !== py || menuOpen)
                this._wake(state);
            else
                this._module.later(`dock-idle-${state.id}`, IDLE_POLL_MS, check);
        };
        this._module.later(`dock-idle-${state.id}`, IDLE_POLL_MS, check);
    }

    start(dock) {
        const state = this._docks.get(dock);
        if (!state || state.active)
            return;
        this._measure(state);
        const placed = this._locate(state);
        if (!placed.length)
            return;
        this._unclip(state);
        // Whole-row growth is about zoom x radius (the bell's area), all of it
        // on one side at the row's ends.
        const most = (this._scale() - 1) * state.iconSize * this._module.settings.get_double('dock-magnify-reach') +
            state.iconSize / 2;
        state.dash._background?._glassLayer?.setRoom(state.vertical
            ? {top: most, bottom: most} : {left: most, right: most});
        state.seatedAt = null;
        state.active = true;
        state.lastFrame = Date.now();
        state.presence = 0;
        state.timeline.start();
    }

    _frame(state) {
        const now = Date.now();
        const dt = Math.max(1, Math.min(64, now - state.lastFrame));
        state.lastFrame = now;
        if (state.dirty)
            this._measure(state);
        const slots = this._locate(state);
        if (!slots.length) {
            this._restAll(state);
            return;
        }
        const [x, y] = global.get_pointer();
        // A click seats the row: everything eases home while the app opens, and
        // the wave only returns when the pointer moves on.
        if (state.seatedAt && Math.hypot(x - state.seatedAt[0], y - state.seatedAt[1]) > SEATED_SLOP)
            state.seatedAt = null;
        // An icon being dragged has the row to itself, and an open context menu
        // shouldn't sit on a raised icon.
        const menuOpen = slots.some(slot => slot.actor.child?._menu?.isOpen);
        const over = this._enabled && !menuOpen && !state.dash._dragPlaceholder && this._inside(state, x, y);
        const inside = over && !state.seatedAt;
        const cursor = state.vertical ? y : x;

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
            const {value} = slot;
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

        if (moving)
            return;
        if (over)
            this._sleep(state);
        else
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
        const drop = state.vertical ? 0 : state.dock._position === St.Side.TOP ? -DOT_DROP : DOT_DROP;
        const {actor, visual} = slot;
        const bouncing = visual?._bouncing;
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
            if (drop && !bouncing)
                dot.translation_y = drop * inverse;
        }
    }

    _restAll(state) {
        state.timeline?.stop();
        for (const slot of state.slots ?? []) {
            if (!slot.dead)
                this._apply(state, slot, {scale: 1, shift: 0});
        }
        state.dash._background?._glassLayer?.setRoom({});
        state.active = false;
        state.seatedAt = null;
        // Fresh at the next hover; the row may have changed by then.
        state.slots = null;
        this._reclip(state);
    }
}
