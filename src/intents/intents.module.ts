import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [IntentsController],
  providers: [
    IntentsService,
    IntentsGateway,
    IntentsSweeperService,
    {
      provide: INTENTS_REPOSITORY,
      useClass: InMemoryIntentsRepository,
    },
  ],
  exports: [IntentsService, IntentsGateway],
})
export class IntentsModule {}
