import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SECONDS = 300;

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Codex Usage');
        this._label = new St.Label({text: 'Codex —', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
        this._status = new PopupMenu.PopupMenuItem('Checking Codex usage…', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refresh);
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    _refresh() {
        if (this._process) return;
        try {
            const pis = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'pis']);
            this._process = Gio.Subprocess.new([pis, '--codex-usage'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            this._process.communicate_utf8_async(null, null, (_process, result) => {
                try {
                    const [, stdout, stderr] = this._process.communicate_utf8_finish(result);
                    if (!this._process.get_successful()) throw new Error(stderr.trim() || 'pis failed');
                    this._update(JSON.parse(stdout));
                } catch (error) {
                    this._label.set_text('Codex —');
                    this._status.label.set_text(`Unavailable: ${error.message}`);
                } finally {
                    this._process = null;
                }
            });
        } catch (error) {
            this._status.label.set_text(`Unavailable: ${error.message}`);
        }
    }

    _update(data) {
        const windows = ['primary_window', 'secondary_window']
            .map(name => data.rate_limit?.[name])
            .filter(window => window && Number.isFinite(window.used_percent))
            .map(window => Math.max(0, Math.min(100, 100 - window.used_percent)));
        if (!windows.length) throw new Error('No quota windows returned');
        this._label.set_text(`Codex ${windows.map(value => `${Math.round(value)}%`).join(' / ')}`);
        this._status.label.set_text(`Remaining: ${windows.map(value => `${value.toFixed(1)}%`).join(' / ')}`);
    }

    destroy() {
        if (this._timeout) GLib.source_remove(this._timeout);
        if (this._process) this._process.force_exit();
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator();
        Main.panel.addToStatusArea('codex-usage', this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
