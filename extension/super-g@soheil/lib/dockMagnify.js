// SPDX-License-Identifier: GPL-3.0-or-later
// Apple-style dock magnification for the dock engine (Dash to Dock).
// Runs per frame on transforms only, never touching layout: icons follow a
// cosine bell around the pointer and grow from their base edge, neighbours
// slide apart so the icon under the pointer stays under it, and the glass
// stretches with the row. Every value eases towards its target with the frame
// time, so the motion stays smooth however the pointer events arrive.
// The approach follows Dhruva's magnifier by NarkAgni (GPL-3.0).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Share of the distance covered per 60 Hz frame.
const FOLLOW = 0.3;
const SETTLE = 0.2;
const FRAME_MS = 1000 / 60;
const DONE = 0.002;
// How far past the row's ends the wave fades out, in slots.
const END_FADE = 0.9;
// How far past the dock, towards the screen's edge, still counts as on it.
const EDGE_ZONE = 48;
// How long a changed row gets to finish animating before it's measured again.
const RESETTLE_MS = 350;
// A press on the dock that hasn't moved this far since keeps the row settled.
const SEATED_SLOP = 6;
// Share of an icon, from its centre, that counts as the pointer having reached
// it: drifting over the line while heading up and away doesn't.
const ICON_CORE = 0.4;
// While nothing moves, frames stop and this watches the pointer instead.
const IDLE_POLL_MS = 80;
// The running dot's distance below the icon's edge.
const DOT_DROP = 7;
const REVEAL_WATCH_MS = 1500;
const REVEAL_POLL_MS = 30;
const DOT_FADE_MS = 220;
// A launch: hops of this share of the icon, each lower than the last, repeating
// while the app starts, as on a Mac.
const BOUNCE_HEIGHT = 0.42;
const BOUNCE_MS = 420;
const DAMPING = 0.82;
const BOUNCE_MIN = 1;
const BOUNCE_MAX = 12;

const approach = (from, to, factor) =>
    Math.abs(to - from) < DONE ? to : from + (to - from) * factor;

const isItem = actor =>
    actor.has_style_class_name?.('dash-item-container') || actor.has_style_class_name?.('dash-separator');

// Picking skips whatever lies outside an actor's paint volume, and the scroll
// view reports its own box, so nothing that rose out of it could be clicked.
const RaisedVolume = GObject.registerClass(
class SuperGRaisedVolume extends Clutter.Effect {
    _init(room) {
        super._init();
        this._room = room;
    }

    vfunc_modify_paint_volume(volume) {
        const {width, height} = this.get_actor();
        const {left, right, top, bottom} = this._room;
        volume.set_origin(new Graphene.Point3D({x: -left, y: -top, z: 0}));
        volume.set_width(width + left + right);
        volume.set_height(height + top + bottom);
        return true;
    }
});

export class DockMagnifier {
    constructor(module, dockExt) {
        this._module = module;
        this._dockExt = dockExt;
        this._dockSettings = module.instance.getSettings();
        this._docks = new Map();
        this._bounces = new Set();
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
                    if (state.active && this._inside(state, x, y))
                        this._seat(state, x, y);
                    this._wake(state);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // A dragged app, from the dock or the drawer, has the row to itself.
        const dragging = on => {
            this._dragging = on;
            for (const state of this._docks.values())
                this._wake(state);
        };
        Main.overview.connectObject(
            'item-drag-begin', () => dragging(true),
            'item-drag-end', () => dragging(false),
            'item-drag-cancelled', () => dragging(false), this);
        this._attachAll();
    }

    disable() {
        Main.overview.disconnectObject(this);
        global.stage.disconnect(this._stageId);
        this._stageId = 0;
        global.stage.disconnect(this._clickId);
        this._clickId = 0;
        if (this._readyId)
            this._dockExt.dockManager?.disconnect(this._readyId);
        this._readyId = 0;
        for (const timeline of [...this._bounces])
            timeline.stop();
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
            dock, dash, active: false, slots: null, presence: 0, watched: [], strips: new Set(), id: this._docks.size,
            vertical: !(dash._isHorizontal ?? true),
            // On the stage: an autohidden dock is on no monitor, which would
            // freeze a timeline bound to it with the row still spread.
            timeline: new Clutter.Timeline({actor: global.stage, duration: 1000, repeat_count: -1}),
        };
        state.timeline.connect('new-frame', () => this._module.guard(() => this._frame(state)));
        // Icons come and go (a launch, a minimize) while the wave runs.
        const roots = [dash._box, dash._box.get_parent()].filter(Boolean);
        for (const box of roots) {
            state.watched.push([box, box.connect('child-added', () => this._rowChanged(state))],
                [box, box.connect('child-removed', () => this._rowChanged(state))]);
        }
        dash.connect('destroy', () => (state.gone = true));
        // Revealing the dock means the pointer is past it, likely over a window,
        // and motion there goes to the app, not the shell. So look for it.
        state.watched.push([dock, dock.connect('showing', () => this._watchReveal(state))]);
        this._docks.set(dock, state);
        this._watchStrips(state);
        this._evenDividers(state);
        this._placeDots(state);
        this._hookLaunches(state);
    }

    _rowChanged(state) {
        if (state.gone)
            return;
        state.dirty = true;
        this._wake(state);
        this._watchStrips(state);
        this._evenDividers(state);
        this._module.later('dock-dots', RESETTLE_MS, () => {
            this._placeDots(state);
            if (!state.gone)
                this._hookLaunches(state);
        });
    }

    // Strips beside the row hold items too (minimized windows, the stack, Trash).
    _watchStrips(state) {
        for (const strip of state.dash._box.get_parent()?.get_children() ?? []) {
            if (strip === state.dash._box || !(strip instanceof St.BoxLayout) || state.strips.has(strip))
                continue;
            state.strips.add(strip);
            strip.connectObject(
                'child-added', () => this._rowChanged(state),
                'child-removed', () => this._rowChanged(state),
                'destroy', () => state.strips.delete(strip), state.dash);
        }
    }

    // At a fractional scale a 1 px line covers one device pixel or two, depending
    // on where it lands, so two dividers came out different. A whole number of
    // device pixels is the same anywhere. Scaled, as the row's layout stays put.
    _evenDividers(state) {
        const monitorScale = global.display.get_monitor_scale(state.dash._monitorIndex ?? 0);
        const thickness = Math.max(1, Math.round(monitorScale)) / monitorScale;
        for (const item of this._items(state)) {
            if (!item.has_style_class_name('dash-separator'))
                continue;
            item.set_pivot_point(0.5, 0.5);
            if (state.vertical)
                item.scale_y = thickness;
            else
                item.scale_x = thickness;
        }
    }

    // The icon fills its box, so the box's own bottom edge is inside the art;
    // the dot belongs below it, in the dock's padding.
    _placeDots(state) {
        if (state.vertical || !this._docks.has(state.dock) || state.gone)
            return;
        const drop = this._dotDrop(state);
        for (const item of this._items(state)) {
            for (const dot of this._dots(item))
                dot.translation_y = drop;
        }
    }

    _dotDrop(state) {
        if (state.vertical)
            return 0;
        return state.dock._position === St.Side.TOP ? -DOT_DROP : DOT_DROP;
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
        for (const item of this._items(state)) {
            this._hookLabel(item);
            for (const dot of this._dots(item)) {
                if (dot._superGFade)
                    continue;
                dot._superGFade = true;
                // A running dot arrives softly instead of popping in.
                dot.connect('notify::visible', () => {
                    if (!dot.visible)
                        return;
                    dot.opacity = 0;
                    dot.ease({opacity: 255, duration: DOT_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                });
                // The engine puts it back at every style change, a hover included.
                dot.connect('notify::translation-y', () => {
                    const visual = this._visual(item);
                    if (!visual || visual._bouncing)
                        return;
                    const place = this._dotDrop(state) / visual.scale_y;
                    if (Math.abs(dot.translation_y - place) > 0.01)
                        dot.translation_y = place;
                });
            }
        }
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
        // Clear of whatever clips the row, for as long as it's in the air.
        this._unclip(state);
        state.hops = (state.hops ?? 0) + 1;
        const side = state.dock._position;
        const [axis, sign] = {
            [St.Side.LEFT]: ['translation_x', 1], [St.Side.RIGHT]: ['translation_x', -1],
            [St.Side.TOP]: ['translation_y', 1],
        }[side] ?? ['translation_y', -1];
        const height = (state.vertical ? visual.width : visual.height) * BOUNCE_HEIGHT;
        const dots = this._dots(item);
        const app = item.child.app;
        let hop = 0;
        // On the stage, not the icon: a dock sliding away for the new window is on
        // no monitor, and a timeline on it freezes mid-hop for good. Held here,
        // as a collected timeline would just as silently stop; a property on the
        // actor isn't enough, its wrapper can go first.
        const timeline = new Clutter.Timeline({actor: global.stage, duration: BOUNCE_MS, repeat_count: BOUNCE_MAX - 1});
        this._bounces.add(timeline);
        const place = lift => {
            visual[axis] = lift * sign;
            // The dot stays on the dock, at the place for the icon's scale now:
            // the row may well come to rest while this hops.
            const rest = axis === 'translation_y' ? this._dotDrop(state) / visual.scale_y : 0;
            for (const dot of dots)
                dot[axis] = rest - lift * sign;
        };
        const stop = () => {
            if (!visual._bouncing)
                return;
            visual._bouncing = false;
            visual.disconnectObject(timeline);
            timeline.stop();
            place(0);
            this._bounces.delete(timeline);
            state.hops--;
            if (!state.active && !state.gone)
                this._reclip(state);
        };
        timeline.connect('new-frame', (_t, ms) => {
            const t = ms / BOUNCE_MS;
            place(height * DAMPING ** hop * 4 * t * (1 - t));
        });
        timeline.connect('stopped', stop);
        // A hop always lands; only then is the app asked whether it's up.
        timeline.connect('completed', () => {
            hop++;
            if (hop >= BOUNCE_MAX || (hop >= BOUNCE_MIN && app?.state !== Shell.AppState.STARTING))
                stop();
        });
        // A hidden dock's frames stop too, so never leave one waiting up there.
        visual.connectObject('notify::mapped', () => {
            if (!visual.mapped)
                stop();
        }, timeline);
        timeline.start();
    }

    _detach(state) {
        if (state.gone) {
            this._docks.delete(state.dock);
            return;
        }
        for (const [obj, id] of state.watched)
            obj.disconnect(id);
        for (const strip of state.strips)
            strip.disconnectObject(state.dash);
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
        const icon = state.iconSize ?? 64;
        const along = (this._scale() - 1) * icon * this._reach() + icon / 2;
        const across = (this._scale() - 1 + BOUNCE_HEIGHT) * icon;
        const side = state.dock._position;
        state.raised = new RaisedVolume({
            left: state.vertical ? (side === St.Side.LEFT ? 0 : across) : along,
            right: state.vertical ? (side === St.Side.LEFT ? across : 0) : along,
            top: state.vertical ? along : (side === St.Side.TOP ? 0 : across),
            bottom: state.vertical ? along : (side === St.Side.TOP ? across : 0),
        });
        state.dash._scrollView.add_effect(state.raised);
        // A viewport also clips picking while it has adjustments. A row that
        // scrolls needs them, so it keeps to its view.
        const viewport = state.dash._boxContainer;
        const {hadjustment, vadjustment} = viewport;
        const scrolls = adjustment => adjustment && adjustment.upper > adjustment.page_size;
        if (!scrolls(hadjustment) && !scrolls(vadjustment)) {
            state.adjustments = {hadjustment, vadjustment};
            viewport.hadjustment = null;
            viewport.vadjustment = null;
        }
        this._refreshVolumes(state);
    }

    // Ancestors keep their volumes cached through an effect's coming and going.
    _refreshVolumes(state) {
        for (let a = state.dash._box; a; a = a.get_parent())
            a.invalidate_paint_volume();
    }

    _reclip(state) {
        if (state.hops > 0)
            return;
        for (const [a, alloc, view] of state.clipped ?? []) {
            a.clip_to_allocation = alloc;
            if (view !== null)
                a.clip_to_view = view;
        }
        if (state.raised) {
            state.dash._scrollView.remove_effect(state.raised);
            state.raised = null;
            if (state.adjustments)
                Object.assign(state.dash._boxContainer, state.adjustments);
            state.adjustments = null;
            this._refreshVolumes(state);
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
            // The button keeps its resting size, so what grew past it would let
            // clicks through to the window below. Events bubble up to the button.
            if (fresh.zooms && fresh.visual)
                fresh.visual.reactive = true;
            // Only its slide. GNOME eases an item's scale and opacity to bring it
            // in or take it out, and cancelling that left a newly pinned icon at
            // size zero and an unpinned one on the row for good.
            actor.remove_transition('translation-x');
            actor.remove_transition('translation-y');
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
                x >= bx - (side === St.Side.RIGHT ? rise : EDGE_ZONE) && x <= bx + bw + (side === St.Side.LEFT ? rise : EDGE_ZONE);
        }
        return x >= bx - pad && x <= bx + bw + pad &&
            y >= by - (side === St.Side.BOTTOM ? rise : EDGE_ZONE) && y <= by + bh + (side === St.Side.TOP ? rise : EDGE_ZONE);
    }

    // Read per frame while hovering, so kept rather than asked of GSettings.
    _scale() {
        return (this._zoomScale ??= this._module.settings.get_double('dock-magnify-scale'));
    }

    _reach() {
        return (this._zoomReach ??= this._module.settings.get_double('dock-magnify-reach'));
    }

    // The dock, plus the gap to the screen's edge: revealing it means pushing
    // the pointer past it, and the wave has to be underway as it comes back up.
    _overDock(state, x, y) {
        const bg = state.dash._background ?? state.dash;
        if (!bg.mapped)
            return false;
        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        const side = state.dock._position;
        return x >= bx - (side === St.Side.LEFT ? EDGE_ZONE : 0) &&
            x <= bx + bw + (side === St.Side.RIGHT ? EDGE_ZONE : 0) &&
            y >= by - (side === St.Side.TOP ? EDGE_ZONE : 0) &&
            y <= by + bh + (side === St.Side.BOTTOM ? EDGE_ZONE : 0);
    }

    _onMotion(state, x, y) {
        if (state.active)
            this._wake(state);
        else if (this._enabled && !this._dragging && this._overDock(state, x, y))
            this.start(state.dock);
    }

    _watchReveal(state) {
        let left = REVEAL_WATCH_MS;
        const look = () => {
            left -= REVEAL_POLL_MS;
            if (state.gone || state.active || !this._enabled || this._dragging || left <= 0)
                return;
            const [x, y] = global.get_pointer();
            if (this._overDock(state, x, y))
                this.start(state.dock);
            else
                this._module.later(`dock-reveal-${state.id}`, REVEAL_POLL_MS, look);
        };
        look();
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
        state.seated = null;
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
        // the wave only returns on another icon or once the pointer has left.
        if (state.seated && this._reachedAnother(state, x, y))
            state.seated = null;
        // An open context menu shouldn't sit on a raised icon.
        const menuOpen = slots.some(slot => slot.actor.child?._menu?.isOpen);
        // A seated row has nothing risen, so the dock alone counts: past it, the
        // row goes to rest and coming back starts a fresh wave.
        const on = state.seated ? this._overDock(state, x, y) : this._inside(state, x, y);
        const over = this._enabled && !menuOpen && !this._dragging && on;
        const inside = over && !state.seated;
        const cursor = state.vertical ? y : x;

        const follow = 1 - (1 - FOLLOW) ** (dt / FRAME_MS);
        const settle = 1 - (1 - SETTLE) ** (dt / FRAME_MS);

        // Targets: the bell around the pointer, fading past the row's ends.
        const zoom = this._scale() - 1;
        const radius = state.iconSize * this._reach();
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

    _seat(state, x, y) {
        this._locate(state);
        state.seated = {x, y, icon: this._nearestIcon(state, state.vertical ? y : x)};
    }

    // The wave keeps a pointer between the same two icons when it spreads them,
    // so the nearest at rest is the one that was under the click.
    _nearestIcon(state, cursor) {
        let nearest = null;
        for (const slot of state.slots) {
            if (slot.zooms && !slot.dead && slot.size > 0 &&
                (!nearest || Math.abs(cursor - slot.center) < Math.abs(cursor - nearest.center)))
                nearest = slot;
        }
        return nearest;
    }

    _reachedAnother(state, x, y) {
        const {seated} = state;
        if (Math.hypot(x - seated.x, y - seated.y) <= SEATED_SLOP || !this._overDock(state, x, y))
            return false;
        const cursor = state.vertical ? y : x;
        const icon = this._nearestIcon(state, cursor);
        return icon && icon !== seated.icon && Math.abs(cursor - icon.center) <= icon.size * ICON_CORE;
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
        const drop = this._dotDrop(state);
        const {actor, visual} = slot;
        const bouncing = visual?._bouncing;
        // Most of the row sits still under a small movement.
        if (slot.lastScale === scale && slot.lastShift === shift && !bouncing && !slot.lastBouncing)
            return;
        [slot.lastScale, slot.lastShift, slot.lastBouncing] = [scale, shift, bouncing];
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
            if (slot.dead)
                continue;
            this._apply(state, slot, {scale: 1, shift: 0});
            if (slot.visual)
                slot.visual.reactive = false;
        }
        state.dash._background?._glassLayer?.setRoom({});
        state.active = false;
        state.seated = null;
        // Fresh at the next hover; the row may have changed by then.
        state.slots = null;
        this._reclip(state);
    }
}
