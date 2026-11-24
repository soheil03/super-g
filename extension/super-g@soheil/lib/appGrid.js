// SPDX-License-Identifier: GPL-3.0-or-later
// The app grid as Apple's: larger icons, folders drawn as one icon-sized plate
// holding a 3x3 preview (not a card the size of the whole tile), and folder
// dialogs sized to the grid they hold rather than GNOME's fixed 550 px.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The plate's share of the icon box: the same as an app icon's plate.
export const PLATE_SHARE = 0.82;
// Corner radius as a part of the plate, per icon shape. CSS corners are
// circular, so the squircle gets the radius that matches its look.
const PLATE_RADIUS = {squircle: 0.27, circle: 0.5, rounded: 0.22, off: 0.24};
// Inside the plate: its padding and the gap between previews, as parts of it.
const PLATE_PAD = 0.1;
const PLATE_GAP = 0.04;
const PREVIEWS = 3;
// The folder dialog's grid: gaps between tiles, the least padding around it.
const FOLDER_GAP = 4;
const FOLDER_PAD = 16;
const FOLDER_SIDE = 3;
// GNOME's PAGE_PREVIEW_RATIO / 2: each side's page arrow strip, of the page.
const ARROW_SHARE = 0.1;
const GNOME_DIALOG_SIZE = 550;
const PLATED = 'super-g-plated';

const appDisplay = () => Main.overview?._overview?.controls?._appDisplay ?? null;

export class AppGridLook {
    constructor(settings) {
        this._settings = settings;
        this._restore = [];
    }

    get iconSize() {
        const size = this._settings.get_int('app-grid-icon-size');
        if (size <= 0)
            return -1;
        // Unshaped icons fill their whole box, where plated ones fill
        // PLATE_SHARE of it: the same setting then drew them a fifth larger.
        return this._settings.get_string('icon-shape') === 'off' ? Math.round(size * PLATE_SHARE) : size;
    }

    enable() {
        const self = this;
        const viewProto = AppDisplay.FolderView.prototype;
        const origCreate = viewProto.createFolderIcon;
        viewProto.createFolderIcon = function (size, folderIcon) {
            try {
                return self._folderIcon(this, size, folderIcon);
            } catch (e) {
                console.error('super-g: folder icon failed', e);
                return origCreate.call(this, size, folderIcon);
            }
        };
        const origGrid = viewProto._createGrid;
        viewProto._createGrid = function () {
            const grid = origGrid.call(this);
            self._sizeFolderGrid(grid);
            return grid;
        };
        const dialogProto = AppDisplay.AppFolderDialog.prototype;
        const origPopup = dialogProto.popup;
        // Sized before the zoom reads the dialog's box, and again once shown:
        // a dialog opened for the first time has unstyled tiles until then.
        const size = dialog => {
            try {
                self._sizeDialog(dialog);
            } catch (e) {
                console.error('super-g: folder dialog size failed', e);
            }
        };
        dialogProto.popup = function (...args) {
            size(this);
            const result = origPopup.apply(this, args);
            size(this);
            return result;
        };
        this._restore.push(() => {
            viewProto.createFolderIcon = origCreate;
            viewProto._createGrid = origGrid;
            dialogProto.popup = origPopup;
        });
        this.apply();
    }

    disable() {
        this._restore.forEach(fn => fn());
        this._restore = [];
        this.apply(false);
    }

    // Grids built already take the size now; their folder icons are rebuilt.
    apply(on = true) {
        const display = appDisplay();
        if (!display)
            return;
        const size = on ? this.iconSize : -1;
        this._setGridSize(display._grid, size);
        for (const item of display._orderedItems ?? []) {
            if (!(item instanceof AppDisplay.FolderIcon))
                continue;
            this._setGridSize(item.view._grid, size);
            if (on)
                this._tighten(item.view._grid);
            if (!on)
                item.remove_style_class_name(PLATED);
            item.icon?._createIconTexture?.(item.icon.iconSize);
            if (!on && item._dialog) {
                item._dialog._viewBox.width = item._dialog._viewBox.height = GNOME_DIALOG_SIZE;
                const layout = item.view._grid.layoutManager;
                layout._fixedRows = layout.rows_per_page = FOLDER_SIDE;
                layout.column_spacing = layout.row_spacing = Math.round(layout._iconSize * 0.5);
            }
        }
    }

    _setGridSize(grid, size) {
        const layout = grid?.layoutManager;
        if (!layout || layout.fixedIconSize === size)
            return;
        layout.fixedIconSize = size;
        // adaptToSize returns early for a page size it has seen.
        layout._pageWidth = layout._pageHeight = -1;
        grid.queue_relayout();
    }

    _sizeFolderGrid(grid) {
        this._tighten(grid);
        this._setGridSize(grid, this.iconSize);
    }

    // IconGrid sets both gaps to half the icon size on every style change,
    // whatever the theme says: Apple's folders sit much closer. Off, GNOME's
    // own gap comes back with the next style change.
    _tighten(grid) {
        const layout = grid?.layoutManager;
        if (!layout)
            return;
        const set = () => {
            if (this._restore.length)
                layout.column_spacing = layout.row_spacing = FOLDER_GAP;
        };
        if (!grid._superGTight) {
            grid._superGTight = true;
            grid.connect_after('style-changed', set);
        }
        set();
    }

    // GNOME fixes the dialog at 550 px whatever the icons; with them larger
    // the 3x3 page crowded its edges, and a folder of four left a blank row.
    // It now holds as many rows as it needs, up to three. The tile's size
    // comes from the theme (label, padding), so it's measured, and so is
    // what the view keeps around the grid: the page arrows' strip on each
    // side (a fifth of the page or an arrow, whichever is wider) and the
    // dots below. Without those the tiles ran under the arrow and the last
    // row was cut off.
    _sizeDialog(dialog) {
        const view = dialog._view;
        const grid = view?._grid;
        const tiles = grid?.get_children().filter(c => c.visible) ?? [];
        const [tile] = tiles;
        if (!tile)
            return;
        const rows = Math.min(FOLDER_SIDE, Math.ceil(tiles.length / FOLDER_SIDE));
        const layout = grid.layoutManager;
        if (layout._fixedRows !== rows) {
            layout._fixedRows = layout.rows_per_page = rows;
            layout._pageWidth = layout._pageHeight = -1;
            grid.queue_relayout();
        }
        const size = this.iconSize;
        if (size > 0)
            tile.icon?.setIconSize?.(size);
        tile.ensure_style();
        // The grid's cells are square, at the tile's larger side.
        const [, tileWidth] = tile.get_preferred_width(-1);
        const [, tileHeight] = tile.get_preferred_height(-1);
        const cell = Math.max(tileWidth, tileHeight);
        if (cell < Math.max(size, 0))
            return;
        const [, header] = dialog._entryBox.get_preferred_height(-1);
        const gridNode = grid.get_theme_node();
        const pagePad = side => Math.max(FOLDER_PAD, gridNode.get_length(`page-padding-${side}`));
        const across = n => n * cell + (n - 1) * layout.column_spacing;
        const down = n => n * cell + (n - 1) * layout.row_spacing;
        const inner = across(FOLDER_SIDE) + pagePad('left') + pagePad('right');
        const arrows = [view._nextPageArrow, view._prevPageArrow]
            .filter(Boolean).map(a => a.get_preferred_width(-1)[0]);
        const arrow = Math.max(0, ...arrows);
        const width = arrow >= ARROW_SHARE * (inner + 2 * arrow) ? inner + 2 * arrow : inner / (1 - 2 * ARROW_SHARE);
        const [, dots] = view._pageIndicators?.get_preferred_height(width) ?? [0, 0];
        const node = dialog._viewBox.get_theme_node();
        dialog._viewBox.width = Math.ceil(width + node.get_horizontal_padding());
        dialog._viewBox.height = Math.ceil(down(rows) + pagePad('top') + pagePad('bottom') + header + dots +
            node.get_vertical_padding());
    }

    // One plate the size of an app icon's, with up to nine previews in it.
    _folderIcon(view, size, folderIcon) {
        folderIcon?.add_style_class_name(PLATED);
        const shape = this._settings.get_string('icon-shape');
        // Unshaped app icons fill their box; so does the folder then.
        const plate = Math.round(size * (shape === 'off' ? 1 : PLATE_SHARE));
        const pad = Math.round(plate * PLATE_PAD);
        const gap = Math.max(1, Math.round(plate * PLATE_GAP));
        const sub = Math.floor((plate - 2 * pad - (PREVIEWS - 1) * gap) / PREVIEWS);
        const layout = new Clutter.GridLayout({row_spacing: gap, column_spacing: gap});
        const inner = new St.Widget({
            style_class: 'super-g-folder-plate',
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            // St's width excludes the padding.
            style: `width: ${plate - 2 * pad}px; height: ${plate - 2 * pad}px; padding: ${pad}px; ` +
                `border-radius: ${Math.round(plate * (PLATE_RADIUS[shape] ?? PLATE_RADIUS.off))}px;`,
        });
        const rtl = inner.get_text_direction() === Clutter.TextDirection.RTL;
        const items = view._orderedItems ?? [];
        for (let i = 0; i < PREVIEWS * PREVIEWS && i < items.length; i++) {
            const bin = new St.Bin({style: `width: ${sub}px; height: ${sub}px;`});
            bin.child = items[i].app.create_icon_texture(sub);
            const column = i % PREVIEWS;
            layout.attach(bin, rtl ? PREVIEWS - 1 - column : column, Math.floor(i / PREVIEWS), 1, 1);
        }
        // App icons lay out at their plate's size too, so labels line up.
        return inner;
    }
}
