import { Menu, Tray, nativeImage } from 'electron';
import * as path from 'node:path';
import { tMain } from './lang';

export interface TrayHandlers {
  onToggle: () => void;
  onSettings: () => void;
  onHistory: () => void;
  onQuit: () => void;
  onStartupToggle: (enabled: boolean) => void;
}

export class MindScriptTray {
  private tray: Tray;
  private hotkeyLabel = '';

  constructor(private handlers: TrayHandlers) {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    this.tray = new Tray(icon);
    this.tray.setToolTip(tMain('tray.tooltip'));
    this.rebuild(false, false);
    this.tray.on('double-click', handlers.onToggle);
  }

  private startupChecked = false;

  rebuild(recording: boolean, startupEnabled: boolean): void {
    this.startupChecked = startupEnabled;
    const label = recording ? tMain('tray.stop') : tMain('tray.start');
    const hint = this.hotkeyLabel ? ` (${this.hotkeyLabel})` : '';
    this.tray.setToolTip(tMain('tray.tooltip'));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${label}${hint}`, click: this.handlers.onToggle },
        { type: 'separator' },
        { label: tMain('tray.settings'), click: this.handlers.onSettings },
        { label: tMain('tray.history'), click: this.handlers.onHistory },
        { type: 'separator' },
        {
          label: tMain('tray.startup'),
          type: 'checkbox',
          checked: this.startupChecked,
          click: (item) => this.handlers.onStartupToggle(item.checked),
        },
        { type: 'separator' },
        { label: tMain('tray.quit'), click: this.handlers.onQuit },
      ]),
    );
  }

  setHotkeyLabel(accelerator: string): void {
    this.hotkeyLabel = accelerator
      .replace(/Control/gi, 'Ctrl')
      .replace(/\+/g, '+');
    this.rebuild(false, this.startupChecked);
  }
}
