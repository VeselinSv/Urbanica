import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, ErrorFilter } from './common';
import { AuthController, BankController, CityController, CompanyController, ContractController, MarketController, WorldController } from './controllers';
import { AllianceController, GovernanceController, HealthController, SocialController, TechController } from './controllers2';
import { GameGateway } from './gateway';

/**
 * Модулен монолит: всички REST контролери и WebSocket шлюзът в един процес.
 * Бизнес логиката е в @gce/domain (споделена с worker-а); тук са само транспорт, валидиране и права.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 300) }],
      // Само за тестове при натоварване извън production (всички заявки идват от един IP).
      skipIf: () => process.env.LOAD_TEST_DISABLE_THROTTLE === 'true' && process.env.NODE_ENV !== 'production',
    }),
  ],
  controllers: [
    AuthController,
    WorldController,
    CityController,
    CompanyController,
    MarketController,
    ContractController,
    BankController,
    GovernanceController,
    TechController,
    AllianceController,
    SocialController,
    HealthController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
    GameGateway,
  ],
})
export class AppModule {}
