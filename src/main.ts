import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST;
const LEGACY_SERVER_URL = process.env.LEGACY_SERVER_URL;

declare const module: any;

async function bootstrap() {
  if(HOST && LEGACY_SERVER_URL) {
    const app = await NestFactory.create(AppModule);
    await app.listen(PORT);
    console.log(`Server running at ${HOST}:${PORT}`)

    if (module.hot) {
      module.hot.accept();
      module.hot.dispose(() => app.close());
    }
  } else {
    throw Error('HOST and LEGACY_SERVER_URL enviroment variables must be set!')
  }
  
}
bootstrap();
