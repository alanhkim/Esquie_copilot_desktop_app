import { app } from 'electron';
import { join } from 'node:path';
import { createDesktop } from './app.mjs';

app.setPath('userData', join(process.env.LOCALAPPDATA || app.getPath('appData'), 'EsquieLocal', 'Desktop'));
createDesktop().register();
