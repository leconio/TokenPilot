import "reflect-metadata";

import { loadEnvironment } from "@tokenpilot/shared";

import { toApiConfiguration } from "./api-config.js";
import { createApiApplication } from "./application.js";

const configuration = toApiConfiguration(loadEnvironment(process.env));
const application = await createApiApplication(configuration, { logger: true });
application.enableShutdownHooks();
await application.listen(configuration.port, "0.0.0.0");
