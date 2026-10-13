import { listen } from './app.js';
import { config } from './config.js';

const { port } = await listen(config.port);
console.log(`Call Copilot running at http://localhost:${port}`);
console.log('Add API keys from the Keys button in the app.');
