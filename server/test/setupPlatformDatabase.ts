import 'dotenv/config';

import { ensurePlatformTestDatabaseUrl } from './helpers/platformTestDatabase';

process.env.PLATFORM_DATABASE_URL = await ensurePlatformTestDatabaseUrl();
