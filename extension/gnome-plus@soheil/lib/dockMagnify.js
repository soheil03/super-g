// SPDX-License-Identifier: GPL-3.0-or-later
// Apple-style dock magnification for the dock engine (Dash to Dock).
// Icons near the pointer grow from their base edge with a cos² falloff; their
// slots widen so neighbours make room and the dock grows with them.
// Everything eases back when the pointer leaves.
// Flourish's own hover wave doesn't track Dash to Dock 110's layout, so its
// hover is turned off and this replaces it.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

const FOLLOW_MS = 90;
const RELEASE_MS = 220;

export class DockMagnifier {
    constructor(module, dockExt) {
        this._module = module;
        this._dockExt = dockExt;
        this._attached = new Map();
    }

    get _enabled() {
        const s = this._module.settings;
        const on = s.get_boolean('dock-magnify') && !s.get_boolean('reduce-motion') &&
            St.Settings.get().enable_animations;
        // One line in the journal says whether the wave runs, and if not why.
        if (this._reported !== on) {
            this._reported = on;
            console.log(`gnome-plus: dock magnification ${on ? 'active' : 'off'} ` +
                `(setting ${s.get_boolean('dock-magnify')}, reduce-motion ${s.get_boolean('reduce-motion')}, ` +
                `animations ${St.Settings.get().enable_animations})`);
        }
        return on;
    }

    enable() {
        const manager = this._dockExt.dockManager;
        this._readyId = manager?.connect('docks-ready', () => this._attachAll());
        this._attachAll();
    }

    disable() {
        if (this._stageId)
            global.stage.disconnect(this._stageId);
        if (this._leaveId)
            global.stage.disconnect(this._leaveId);
        this._stageId = this._leaveId = 0;
        if (this._readyId)
            this._dockExt.dockManager?.disconnect(this._readyId);
        this._readyId = 0;
        for (const dock of [...this._attached.keys()])
            this._detach(dock);
    }

    _attachAll() {
        for (const dock of [...this._attached.keys()])
            this._detach(dock);
        for (const dock of this._dockExt.dockManager?._allDocks ?? [])
            this._attach(dock);
    }

    // Pointer tracking happens on the stage, like Flourish's: events always
    // reach it, however the dock's own actors handle them.
    _attach(dock) {
        const box = dock.dash?._box;
        if (!box)
            return;
        const ids = [
            [box, box.connect('child-added', () => this.release(dock, 0))],
            [box, box.connect('child-removed', () => this.release(dock, 0))],
        ];
        this._attached.set(dock, ids);
        if (!this._stageId) {
            this._stageId = global.stage.connect('motion-event', (_s, event) => {
                const [x, y] = event.get_coords();
                for (const d of this._attached.keys())
                    this._track(d, x, y);
                return Clutter.EVENT_PROPAGATE;
            });
            this._leaveId = global.stage.connect('leave-event', () => {
                for (const d of this._attached.keys())
                    this.release(d);
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    // Inside the dock (plus the room grown icons take up) the wave follows
    // the pointer; leaving it lets everything settle back.
    _track(dock, x, y) {
        const bg = dock.dash?._background ?? dock.dash;
        if (!bg?.mapped)
            return;
        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        const horizontal = dock.dash._isHorizontal ?? true;
        const active = this._rest?.has(dock);
        // Once magnifying, keep tracking over the risen icons too.
        const grow = active ? bh * (this._module.settings.get_double('dock-magnify-scale') - 1) : 0;
        const side = dock._position;
        const inside = horizontal
            ? x >= bx && x <= bx + bw &&
              y >= by - (side === St.Side.BOTTOM ? grow : 0) && y <= by + bh + (side === St.Side.TOP ? grow : 0)
            : y >= by && y <= by + bh &&
              x >= bx - (side === St.Side.RIGHT ? grow : 0) && x <= bx + bw + (side === St.Side.LEFT ? grow : 0);
        if (inside)
            this.applyAt(dock, x, y);
        else if (active)
            this.release(dock);
    }

    _detach(dock) {
        for (const [obj, id] of this._attached.get(dock) ?? [])
            obj.disconnect(id);
        this._attached.delete(dock);
        this.release(dock, 0);
        this._reclip(dock);
    }

    // Grown icons rise above the dock, so nothing between the icons and
    // the dock may clip them. Originals are restored on detach.
    _unclip(dock) {
        if (this._clipped?.has(dock))
            return;
        this._clipped ??= new Map();
        const saved = [];
        for (let a = dock.dash?._box; a && a !== dock.get_parent(); a = a.get_parent()) {
            saved.push([a, a.clip_to_allocation, 'clip_to_view' in a ? a.clip_to_view : null]);
            a.clip_to_allocation = false;
            if ('clip_to_view' in a)
                a.clip_to_view = false;
        }
        this._clipped.set(dock, saved);
    }

    _reclip(dock) {
        for (const [a, alloc, view] of this._clipped?.get(dock) ?? []) {
            a.clip_to_allocation = alloc;
            if (view !== null)
                a.clip_to_view = view;
        }
        this._clipped?.delete(dock);
    }

    // Apple's way: each icon's slot widens, so the layout pushes neighbours
    // apart and the dock (and its glass) grows with it; the icon itself is
    // scaled up from its base edge. Distances use the resting layout, so the
    // wave doesn't chase itself. Public so tests can drive it.
    applyAt(dock, x, y) {
        if (!this._enabled)
            return;
        const dash = dock.dash;
        const box = dash?._box;
        if (!box)
            return;
        const horizontal = dash._isHorizontal ?? true;
        const s = this._module.settings;
        const maxScale = s.get_double('dock-magnify-scale');
        const reach = s.get_double('dock-magnify-reach');
        const items = box.get_children().filter(item => item.child && item.visible);
        if (!items.length)
            return;
        this._unclip(dock);

        this._rest ??= new Map();
        if (!this._rest.has(dock)) {
            this._rest.set(dock, {
                start: horizontal ? items[0].x : items[0].y,
                sizes: new Map(items.map(i => [i, horizontal ? i.width : i.height])),
            });
        }
        const rest = this._rest.get(dock);
        const [bx, by] = box.get_transformed_position();
        const pointer = horizontal ? x - bx : y - by;

        let pos = rest.start;
        for (const item of items) {
            const size = rest.sizes.get(item) ?? (horizontal ? item.width : item.height);
            rest.sizes.set(item, size);
            const center = pos + size / 2;
            pos += size;
            const d = Math.abs(pointer - center);
            const reachPx = size * reach;
            let scale = 1;
            if (d < reachPx) {
                const k = Math.cos(d / reachPx * Math.PI / 2);
                scale = 1 + (maxScale - 1) * k * k;
            }
            this._ease(item, horizontal ? {width: size * scale} : {height: size * scale}, FOLLOW_MS);
            const visual = item.child.get_first_child?.() ?? item.child;
            visual.set_pivot_point(horizontal ? 0.5 : (dock._position === St.Side.RIGHT ? 1 : 0),
                horizontal ? (dock._position === St.Side.TOP ? 0 : 1) : 0.5);
            this._ease(visual, {scale_x: scale, scale_y: scale}, FOLLOW_MS);
        }
    }

    release(dock, duration = RELEASE_MS) {
        const rest = this._rest?.get(dock);
        const horizontal = dock.dash?._isHorizontal ?? true;
        for (const item of dock.dash?._box?.get_children() ?? []) {
            const visual = item.child?.get_first_child?.() ?? item.child;
            if (visual)
                this._ease(visual, {scale_x: 1, scale_y: 1}, duration);
            const size = rest?.sizes.get(item);
            if (size === undefined)
                continue;
            const done = () => (horizontal ? item.set_width(-1) : item.set_height(-1));
            if (!duration) {
                item.remove_all_transitions();
                done();
            } else {
                item.ease({...(horizontal ? {width: size} : {height: size}), duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: done});
            }
        }
        this._rest?.delete(dock);
    }

    _ease(actor, props, duration) {
        if (!duration) {
            actor.remove_all_transitions();
            actor.set(props);
            return;
        }
        actor.ease({...props, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
}
