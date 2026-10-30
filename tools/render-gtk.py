#!/usr/bin/env python3
"""Render mock GTK4/libadwaita and GTK3 windows to PNG with a sandboxed theme.

    tools/render.sh <sandbox> <out-dir> [light|dark]

Run through tools/render.sh, which sets XDG_CONFIG_HOME/XDG_DATA_HOME to the
sandbox written by tools/gen.js and starts a headless broadway display for
GTK4. GTK3 uses an offscreen window, so nothing appears on screen.
"""
import sys

TOOLKIT, OUT, SCHEME = sys.argv[1], sys.argv[2], sys.argv[3]
DARK = SCHEME == 'dark'
LAYOUT = 'appmenu:minimize,maximize,close'
FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Projects', 'Videos', 'Public']
PLACES = [('document-open-recent-symbolic', 'Recent'), ('starred-symbolic', 'Starred'),
          ('user-home-symbolic', 'Home'), ('folder-documents-symbolic', 'Documents'),
          ('folder-download-symbolic', 'Downloads'), ('folder-pictures-symbolic', 'Pictures'),
          ('user-trash-symbolic', 'Trash')]


def gtk4():
    import gi
    gi.require_version('Gtk', '4.0')
    gi.require_version('Adw', '1')
    gi.require_version('Gsk', '4.0')
    from gi.repository import Adw, Gdk, GLib, Gsk, Gtk

    Adw.init()
    # libadwaita installs its own empty GTK theme; forcing gtk-theme-name here
    # would load GTK's built-in theme on top and hide our overrides.
    settings = Gtk.Settings.get_default()
    settings.props.gtk_decoration_layout = LAYOUT
    settings.props.gtk_font_name = 'Ubuntu Sans 11'
    Adw.StyleManager.get_default().props.color_scheme = (
        Adw.ColorScheme.FORCE_DARK if DARK else Adw.ColorScheme.FORCE_LIGHT)

    def files_window():
        sidebar_list = Gtk.ListBox(css_classes=['navigation-sidebar'])
        for icon, name in PLACES:
            row = Gtk.Box(spacing=10, margin_start=4)
            row.append(Gtk.Image(icon_name=icon))
            row.append(Gtk.Label(label=name, xalign=0))
            sidebar_list.append(row)
        sidebar_list.select_row(sidebar_list.get_row_at_index(2))
        side_tv = Adw.ToolbarView()
        side_tv.add_top_bar(Adw.HeaderBar(show_title=False))
        side_tv.set_content(sidebar_list)

        flow = Gtk.FlowBox(max_children_per_line=6, selection_mode=Gtk.SelectionMode.SINGLE,
                           margin_top=12, margin_start=12, margin_end=12, row_spacing=12)
        for name in FOLDERS:
            b = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            b.append(Gtk.Image(icon_name='folder', pixel_size=64))
            b.append(Gtk.Label(label=name))
            flow.append(b)
        flow.select_child(flow.get_child_at_index(1))
        hb = Adw.HeaderBar()
        hb.pack_start(Gtk.Button(icon_name='go-previous-symbolic'))
        hb.pack_start(Gtk.Button(icon_name='go-next-symbolic'))
        hb.pack_end(Gtk.MenuButton(icon_name='open-menu-symbolic'))
        hb.pack_end(Gtk.Button(icon_name='system-search-symbolic'))
        content_tv = Adw.ToolbarView(content=flow)
        content_tv.add_top_bar(hb)
        content_tv.add_css_class('view')

        split = Adw.NavigationSplitView(
            sidebar=Adw.NavigationPage(title='Places', child=side_tv),
            content=Adw.NavigationPage(title='Home', child=content_tv))
        return Adw.ApplicationWindow(content=split, default_width=900, default_height=540, title='Files')

    def settings_window():
        page = Adw.PreferencesPage()
        g = Adw.PreferencesGroup(title='Appearance', description='Choose how windows look.')
        g.add(Adw.SwitchRow(title='Dark style', active=DARK))
        combo = Adw.ComboRow(title='Window buttons', model=Gtk.StringList.new(['Capsule group', 'Mini dots']))
        g.add(combo)
        g.add(Adw.ActionRow(title='Accent color', subtitle='Lavender'))
        g.add(Adw.SpinRow.new_with_range(0, 100, 1))
        page.add(g)
        g2 = Adw.PreferencesGroup(title='Buttons')
        box = Gtk.Box(spacing=8, halign=Gtk.Align.START)
        box.append(Gtk.Button(label='Apply', css_classes=['suggested-action', 'pill']))
        box.append(Gtk.Button(label='Reset', css_classes=['pill']))
        box.append(Gtk.Button(label='Delete', css_classes=['destructive-action']))
        box.append(Gtk.Entry(placeholder_text='Search'))
        box.append(Gtk.CheckButton(label='Check', active=True))
        box.append(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1))
        box.get_last_child().set_size_request(120, -1)
        box.get_last_child().set_value(60)
        g2.add(box)
        page.add(g2)

        side = Gtk.ListBox(css_classes=['navigation-sidebar'])
        for icon, name in [('network-wireless-symbolic', 'Wi-Fi'), ('bluetooth-symbolic', 'Bluetooth'),
                           ('preferences-desktop-appearance-symbolic', 'Appearance'),
                           ('video-display-symbolic', 'Displays'), ('audio-speakers-symbolic', 'Sound')]:
            row = Gtk.Box(spacing=10)
            row.append(Gtk.Image(icon_name=icon))
            row.append(Gtk.Label(label=name, xalign=0))
            side.append(row)
        side.select_row(side.get_row_at_index(2))
        stv = Adw.ToolbarView(content=side)
        stv.add_top_bar(Adw.HeaderBar(title_widget=Adw.WindowTitle(title='Settings')))
        ctv = Adw.ToolbarView(content=page)
        ctv.add_top_bar(Adw.HeaderBar())
        split = Adw.NavigationSplitView(
            sidebar=Adw.NavigationPage(title='Settings', child=stv),
            content=Adw.NavigationPage(title='Appearance', child=ctv))
        return Adw.ApplicationWindow(content=split, default_width=900, default_height=600)

    renderer = Gsk.CairoRenderer()
    renderer.realize_for_display(Gdk.Display.get_default())
    loop = GLib.MainLoop()
    todo = [('files', files_window()), ('settings', settings_window())]

    def shoot():
        for name, win in todo:
            w, h = win.get_width(), win.get_height()
            snap = Gtk.Snapshot()
            Gtk.WidgetPaintable.new(win).snapshot(snap, w, h)
            node = snap.to_node()
            tex = renderer.render_texture(node, None)
            tex.save_to_png(f'{OUT}/gtk4-{name}-{SCHEME}.png')
        renderer.unrealize()
        loop.quit()
        return False

    for _, win in todo:
        win.present()
    GLib.timeout_add(1200, shoot)
    loop.run()


def gtk3():
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import GLib, Gtk

    s = Gtk.Settings.get_default()
    s.props.gtk_theme_name = 'Unified-dark' if DARK else 'Unified'
    s.props.gtk_decoration_layout = LAYOUT
    s.props.gtk_font_name = 'Ubuntu Sans 11'

    off = Gtk.OffscreenWindow()
    outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    outer.get_style_context().add_class('background')
    hb = Gtk.HeaderBar(title='GTK3 app', subtitle='adw-gtk3 + Unified', show_close_button=True)
    hb.get_style_context().add_class('titlebar')
    hb.pack_end(Gtk.Button.new_from_icon_name('open-menu-symbolic', Gtk.IconSize.BUTTON))
    outer.pack_start(hb, False, False, 0)
    paned = Gtk.Box()
    side = Gtk.ListBox()
    side.get_style_context().add_class('navigation-sidebar')
    for _, name in PLACES:
        side.add(Gtk.Label(label=name, xalign=0, margin=6))
    side.set_size_request(170, -1)
    sw = Gtk.Box()
    sw.get_style_context().add_class('sidebar')
    sw.add(side)
    paned.pack_start(sw, False, False, 0)
    body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin=16)
    row = Gtk.Box(spacing=8)
    ok = Gtk.Button(label='Apply')
    ok.get_style_context().add_class('suggested-action')
    row.pack_start(ok, False, False, 0)
    row.pack_start(Gtk.Button(label='Cancel'), False, False, 0)
    row.pack_start(Gtk.Switch(active=True), False, False, 0)
    row.pack_start(Gtk.CheckButton(label='Check', active=True), False, False, 0)
    body.pack_start(row, False, False, 0)
    body.pack_start(Gtk.Entry(text='Text entry'), False, False, 0)
    sc = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1)
    sc.set_value(60)
    body.pack_start(sc, False, False, 0)
    view = Gtk.TextView()
    view.get_buffer().set_text('A text view uses the view background.')
    body.pack_start(view, True, True, 0)
    paned.pack_start(body, True, True, 0)
    outer.pack_start(paned, True, True, 0)
    off.add(outer)
    off.set_size_request(760, 380)
    off.show_all()

    def shoot():
        off.get_pixbuf().savev(f'{OUT}/gtk3-{SCHEME}.png', 'png', [], [])
        Gtk.main_quit()
        return False

    GLib.timeout_add(600, shoot)
    Gtk.main()


{'gtk4': gtk4, 'gtk3': gtk3}[TOOLKIT]()
