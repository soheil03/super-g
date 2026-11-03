#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Super G's own defaults for the vendored engines, re-applied after tools/vendor.sh
# replaces their schemas. Usage: engine-defaults.py <schemas dir>
import re
import sys

DEFAULTS = {
    'org.gnome.shell.extensions.super-g.corners.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/corners/': {
            'border-width': '1',
            'skip-libadwaita-app': 'false',
            'tweak-kitty-terminal': 'true',
        },
    },
    'org.gnome.shell.extensions.super-g.dock.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/dock/': {
            'click-action': "'minimize'",
            'dash-max-icon-size': '60',
            'disable-overview-on-startup': 'true',
            'height-fraction': '1.0',
            'hide-tooltip': 'true',
            'isolate-workspaces': 'true',
            'max-alpha': '0.7',
            'preview-size-scale': '0.47',
            'scroll-action': "'cycle-windows'",
            'show-apps-always-in-the-edge': 'false',
            'show-apps-at-top': 'true',
        },
    },
    'org.gnome.shell.extensions.super-g.dockmotion.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/dockmotion/': {
            'custom-attention-cycles': '2',
            'custom-attention-intensity': '0.4',
            'custom-attention-interval': '8',
            'custom-attention-peek': 'true',
            'custom-attention-reminders': '5',
            'custom-attention-speed': '0.7',
            'custom-hover-duration': '150',
            'custom-hover-dynamic-spacing': 'true',
            'custom-hover-enabled': 'false',
            'custom-hover-scale': '1.55',
            'custom-launch-effect': "'bounce'",
            'custom-launch-intensity': '0.45',
            'custom-launch-speed': '0.6',
            'custom-neighbor-radius': '2',
            'custom-press-duration': '120',
            'custom-press-effect': "'squash'",
            'custom-press-enabled': 'false',
            'custom-press-intensity': '0.25',
            'dock-outline': "'light'",
            'motion-profile': "'custom'",
        },
    },
    'org.gnome.shell.extensions.super-g.gestures.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/gestures/': {
            'pinch-3-finger-gesture': "'SHOW_DESKTOP'",
            'pinch-4-finger-gesture': "'SHOW_DESKTOP'",
            'vertical-swipe-4-fingers-gesture': "'OVERVIEW_NAVIGATION'",
        },
    },
    'org.gnome.shell.extensions.super-g.hotcorners.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/hotcorners/misc/': {
            'panel-menu-enable': 'false',
        },
    },
    'org.gnome.shell.extensions.super-g.lockscreen.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/lockscreen/': {
            'esc-to-sleep': 'false',
            'lockscreen-mode': "'cupertino'",
        },
    },
    'org.gnome.shell.extensions.super-g.windows.gschema.xml': {
        '/org/gnome/shell/extensions/super-g/windows/': {
            'dock-blur': 'false',
            'dock-styling': 'false',
            'enable-app-window-buttons': 'false',
            'focus-on-overview-exit': 'false',
            'overview-seamless-zoom': 'false',
            'overview-wallpaper-background': 'false',
            'panel-invert-tray-icons': 'true',
            'panel-styling': 'false',
            'panel-transparency-level': '0',
            'popup-menu-styling': 'false',
            'reduce-window-animations': 'false',
            'show-window-controls': 'false',
            'show-window-subtitle': 'false',
        },
    },
}

for name, paths in DEFAULTS.items():
    file = f'{sys.argv[1]}/{name}'
    text = open(file).read()
    for path, values in paths.items():
        schema = re.search(r'''<schema\b[^>]*path=\s*["']%s["'][^>]*>.*?</schema>''' % re.escape(path), text, re.S)
        block = schema.group(0)
        for key, value in values.items():
            block, found = re.subn(r'''(<key\b[^>]*name=["']%s["'][^>]*>.*?<default>)(.*?)(</default>)''' % re.escape(key),
                                   lambda m: m.group(1) + value + m.group(3), block, count=1, flags=re.S)
            assert found == 1, f'{name}: {key} is gone upstream'
        text = text[:schema.start()] + block + text[schema.end():]
    open(file, 'w').write(text)
print('engine defaults applied')
