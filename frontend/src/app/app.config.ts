
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, APP_INITIALIZER, inject } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { routes } from './app.routes';
import { VeConfigurationService } from './ve-configuration.service';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

function initializeVeContext(): () => Promise<void> {
  const cfg = inject(VeConfigurationService);
  return () => firstValueFrom(cfg.initVeContext().pipe(catchError(() => of([])))).then(() => undefined);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    provideAnimations(),
    {
      provide: APP_INITIALIZER,
      useFactory: initializeVeContext,
      multi: true,
    },
  ]
};
