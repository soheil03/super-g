// SPDX-License-Identifier: GPL-3.0-or-later
// Collapsed notification stacks with translucent cards. GNOME paints the
// stacked messages whole under the top one and hides them by making every card
// opaque; with a wash the cards showed through each other. Each stacked card is
// clipped to the strip that peeks out below the card painted over it, so the
// cards can be as translucent as the quick toggles.

import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

const Group = MessageList.NotificationMessageGroup;
let original = null;
// group -> Map(actor -> [handler ids]). A card leaves the map when it's
// destroyed: a lock can dispose one before the group's next update.
const watched = new Map();

function unwatch(group) {
    for (const [actor, ids] of watched.get(group) ?? []) {
        ids.forEach(id => actor.disconnect(id));
        actor.remove_clip();
    }
    watched.delete(group);
}

function stackOf(group) {
    const children = group.get_children();
    // [top, cover, ...stacked, header]: see NotificationMessageGroup.
    if (children.length < 3)
        return null;
    const [top, , ...stack] = children;
    stack.pop();
    return {top, stack};
}

function clip(group) {
    const parts = stackOf(group);
    if (!parts)
        return;
    let above = parts.top;
    for (const card of parts.stack) {
        const from = above.allocation.y2 - card.allocation.y1;
        const height = card.allocation.get_height();
        if (from <= 0)
            card.remove_clip();
        else
            card.set_clip(0, Math.min(from, height), card.allocation.get_width(), Math.max(height - from, 0));
        above = card;
    }
}

function watch(group) {
    unwatch(group);
    const parts = stackOf(group);
    if (!parts)
        return;
    const actors = new Map();
    for (const actor of [parts.top, ...parts.stack]) {
        actors.set(actor, [
            actor.connect('notify::allocation', () => clip(group)),
            actor.connect('destroy', () => actors.delete(actor)),
        ]);
    }
    actors.set(group, [group.connect('destroy', () => watched.delete(group))]);
    watched.set(group, actors);
    clip(group);
}

export function enable() {
    if (original)
        return;
    original = Group.prototype._updateStackedMessagesFade;
    Group.prototype._updateStackedMessagesFade = function (...args) {
        const result = original.apply(this, args);
        try {
            watch(this);
        } catch (e) {
            console.error('super-g: notification stack clip failed', e);
        }
        return result;
    };
}

export function disable() {
    if (!original)
        return;
    Group.prototype._updateStackedMessagesFade = original;
    original = null;
    for (const group of [...watched.keys()])
        unwatch(group);
}
