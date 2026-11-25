import { z } from 'zod';
// Native WebViews enforce CSP without unsafe-eval. Use Zod's interpreter instead
// of runtime code generation, including its Function-based support probe.
z.config({ jitless: true });
