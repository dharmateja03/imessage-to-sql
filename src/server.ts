import { createApp } from "./app";
import { env } from "./config";
import { logger } from "./logger";

const app = createApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "imessage-to-sqldb server started");
});
