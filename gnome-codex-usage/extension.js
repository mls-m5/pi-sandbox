import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { usageWindows } from './usage-format.js';
import { claudeDisplay, usageDisplay } from './usage-display.js';

const REFRESH_SECONDS = 300;

const UsageIndicator = GObject.registerClass(
  class UsageIndicator extends PanelMenu.Button {
    _init() {
      super._init(0.0, 'Codex Usage');
      this._label = new St.Label({ text: 'Codex —', y_align: Clutter.ActorAlign.CENTER });
      this.add_child(this._label);
      this._status = new PopupMenu.PopupMenuItem('Checking Codex usage…', { reactive: false });
      this.menu.addMenuItem(this._status);
      this._claudeStatus = new PopupMenu.PopupMenuItem('Claude: no data yet', { reactive: false });
      this.menu.addMenuItem(this._claudeStatus);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      const refresh = new PopupMenu.PopupMenuItem('Refresh');
      refresh.connect('activate', () => this._refresh());
      this.menu.addMenuItem(refresh);
      this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      });
      this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
        if (this._data) this._renderUsage();
        if (this._claudeData) this._renderClaude();
        return GLib.SOURCE_CONTINUE;
      });
      this._refresh();
    }

    _panelText() {
      const parts = [this._codexPanel, this._claudePanel].filter(Boolean);
      return parts.join(' | ');
    }

    _refresh() {
      this._refreshClaude();
      if (this._destroyed || this._process) return;
      try {
        const pis = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'pis']);
        this._process = Gio.Subprocess.new(
          [pis, '--codex-usage'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        this._process.communicate_utf8_async(null, null, (process, result) => {
          try {
            const [, stdout, stderr] = process.communicate_utf8_finish(result);
            if (this._destroyed) return;
            if (!process.get_successful()) throw new Error(stderr.trim() || 'pis failed');
            this._update(JSON.parse(stdout));
          } catch (error) {
            if (this._destroyed) return;
            this._data = null;
            this._codexPanel = 'Codex —';
            this._label.set_text(this._panelText());
            this._status.label.set_text(`Unavailable: ${error.message}`);
          } finally {
            this._process = null;
          }
        });
      } catch (error) {
        this._process = null;
        this._data = null;
        this._codexPanel = 'Codex —';
        this._label.set_text(this._panelText());
        this._status.label.set_text(`Unavailable: ${error.message}`);
      }
    }

    _update(data) {
      const fetchedAt = Date.now();
      if (!usageWindows(data, fetchedAt, fetchedAt).length)
        throw new Error('No quota windows returned');
      this._data = data;
      this._fetchedAt = fetchedAt;
      this._renderUsage();
    }

    _renderUsage() {
      const display = usageDisplay(this._data, this._fetchedAt);
      this._codexPanel = display.panel;
      this._label.set_text(this._panelText());
      this._status.label.set_text(display.menu);
    }

    // Claude data is a local cache written by the host proxy: reading it costs no
    // upstream request. Its failure never hides the Codex display.
    _refreshClaude() {
      if (this._destroyed || this._claudeProcess) return;
      try {
        const pis = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'pis']);
        this._claudeProcess = Gio.Subprocess.new(
          [pis, '--claude-usage'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        this._claudeProcess.communicate_utf8_async(null, null, (process, result) => {
          try {
            const [, stdout, stderr] = process.communicate_utf8_finish(result);
            if (this._destroyed) return;
            if (!process.get_successful()) throw new Error(stderr.trim() || 'pis failed');
            this._claudeData = JSON.parse(stdout);
            this._claudeFetchedAt = Date.now();
            this._renderClaude();
          } catch (error) {
            if (this._destroyed) return;
            this._claudeData = null;
            this._claudePanel = 'Claude —';
            this._label.set_text(this._panelText());
            this._claudeStatus.label.set_text(`Claude unavailable: ${error.message}`);
          } finally {
            this._claudeProcess = null;
          }
        });
      } catch (error) {
        this._claudeProcess = null;
        this._claudeData = null;
        this._claudePanel = 'Claude —';
        this._claudeStatus.label.set_text(`Claude unavailable: ${error.message}`);
      }
    }

    _renderClaude() {
      const display = claudeDisplay(this._claudeData, this._claudeFetchedAt);
      this._claudePanel = display.panel;
      this._label.set_text(this._panelText());
      this._claudeStatus.label.set_text(display.menu);
    }

    destroy() {
      this._destroyed = true;
      this._data = null;
      this._claudeData = null;
      if (this._tick) GLib.source_remove(this._tick);
      if (this._timeout) GLib.source_remove(this._timeout);
      if (this._process) this._process.force_exit();
      if (this._claudeProcess) this._claudeProcess.force_exit();
      super.destroy();
    }
  },
);

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
