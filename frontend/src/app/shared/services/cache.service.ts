import { Injectable, signal, inject } from '@angular/core';
import { VeConfigurationService } from '../../ve-configuration.service';
import { IFrameworkName, IManagedOciContainer } from '../../../shared/types';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

export interface CacheData {
  frameworks: IFrameworkName[];
  applicationIds: Set<string>;
  hostnames: Set<string>;
  installations: IManagedOciContainer[];
  lastUpdated: number;
}

@Injectable({
  providedIn: 'root'
})
export class CacheService {
  private configService = inject(VeConfigurationService);
  
  // Cache with TTL (Time To Live) - 5 minutes
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  
  private cache = signal<CacheData | null>(null);
  private loading = signal(false);
  private loadingFrameworks = signal(false);
  private loadingApplicationIds = signal(false);
  private loadingHostnames = signal(false);
  private loadingInstallations = signal(false);

  /**
   * Get cached frameworks or load them if cache is empty/expired
   */
  getFrameworks(): Observable<IFrameworkName[]> {
    const cached = this.cache();
    
    // Return cached data if fresh
    if (cached && !this.isExpired(cached.lastUpdated)) {
      return of(cached.frameworks);
    }
    
    // Load if not already loading
    if (!this.loadingFrameworks()) {
      this.loadingFrameworks.set(true);
      return this.configService.getFrameworkNames().pipe(
        map(res => res.frameworks),
        tap(frameworks => {
          this.updateCache({ frameworks });
          this.loadingFrameworks.set(false);
        }),
        catchError(err => {
          this.loadingFrameworks.set(false);
          throw err;
        })
      );
    }
    
    // If loading, return cached data even if expired
    return cached ? of(cached.frameworks) : of([]);
  }

  /**
   * Set application IDs directly (e.g., from Applications-List after loading)
   * This avoids duplicate API calls
   */
  setApplicationIds(applicationIds: string[]): void {
    const ids = new Set<string>(applicationIds);
    this.updateCache({ applicationIds: ids });
  }

  /**
   * Get cached application IDs or load them if cache is empty/expired
   */
  getApplicationIds(): Observable<Set<string>> {
    const cached = this.cache();
    
    // Return cached data if available (even if expired, to avoid unnecessary API calls)
    if (cached && cached.applicationIds.size > 0) {
      return of(cached.applicationIds);
    }
    
    // Only load if cache is completely empty
    if (!this.loadingApplicationIds()) {
      this.loadingApplicationIds.set(true);
      return this.configService.getApplications().pipe(
        map(apps => {
          const ids = new Set<string>(apps.map(app => app.id));
          this.updateCache({ applicationIds: ids });
          this.loadingApplicationIds.set(false);
          return ids;
        }),
        catchError(err => {
          this.loadingApplicationIds.set(false);
          throw err;
        })
      );
    }
    
    // If loading, return cached data even if expired
    return cached ? of(cached.applicationIds) : of(new Set<string>());
  }

  /**
   * Get cached hostnames or load them if cache is empty/expired
   */
  getHostnames(): Observable<Set<string>> {
    const cached = this.cache();
    
    // Return cached data if fresh
    if (cached && !this.isExpired(cached.lastUpdated)) {
      return of(cached.hostnames);
    }
    
    // Load if not already loading
    if (!this.loadingHostnames()) {
      this.loadingHostnames.set(true);
      // TODO: Implement hostname loading from Proxmox cluster
      // For now, return empty set
      const hostnames = new Set<string>();
      this.updateCache({ hostnames });
      this.loadingHostnames.set(false);
      return of(hostnames);
    }
    
    // If loading, return cached data even if expired
    return cached ? of(cached.hostnames) : of(new Set<string>());
  }

  /**
   * Get cached installations or load them if cache is empty/expired
   */
  getInstallations(): Observable<IManagedOciContainer[]> {
    const cached = this.cache();

    // Return cached data if fresh
    if (cached && cached.installations.length > 0 && !this.isExpired(cached.lastUpdated)) {
      return of(cached.installations);
    }

    // Load if not already loading
    if (!this.loadingInstallations()) {
      this.loadingInstallations.set(true);
      return this.configService.getInstallations().pipe(
        tap(installations => {
          this.updateCache({ installations });
          this.loadingInstallations.set(false);
        }),
        catchError(err => {
          this.loadingInstallations.set(false);
          throw err;
        })
      );
    }

    // If loading, return cached data even if expired
    return cached ? of(cached.installations) : of([]);
  }

  /**
   * Set installations directly (e.g., after loading in Installed-List)
   */
  setInstallations(installations: IManagedOciContainer[]): void {
    this.updateCache({ installations });
  }

  /**
   * Preload all cache data in the background
   */
  preloadAll(): void {
    if (this.loading()) {
      return; // Already loading
    }
    
    this.loading.set(true);
    
    // Load all data in parallel
    this.getFrameworks().subscribe({
      error: () => {
        this.loading.set(false);
      }
    });
    
    this.getApplicationIds().subscribe({
      error: () => {
        this.loading.set(false);
      }
    });
    
    this.getHostnames().subscribe({
      next: () => {
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      }
    });
  }

  /**
   * Check if application ID is already taken in local directory
   * Allows creating local applications even if the same ID exists in json directory
   */
  isApplicationIdTaken(applicationId: string): Observable<boolean> {
    return this.configService.getLocalApplicationIds().pipe(
      map(ids => ids.includes(applicationId)),
      catchError(() => {
        // On error, fall back to checking all applications
        return this.getApplicationIds().pipe(
          map(ids => ids.has(applicationId))
        );
      })
    );
  }

  /**
   * Check if hostname is already taken
   */
  isHostnameTaken(hostname: string): Observable<boolean> {
    return this.getHostnames().pipe(
      map(hostnames => hostnames.has(hostname))
    );
  }

  /**
   * Invalidate cache (force reload on next request)
   */
  invalidate(): void {
    this.cache.set(null);
  }

  /**
   * Update cache with partial data
   */
  private updateCache(partial: Partial<CacheData>): void {
    const current = this.cache();
    const updated: CacheData = {
      frameworks: partial.frameworks ?? current?.frameworks ?? [],
      applicationIds: partial.applicationIds ?? current?.applicationIds ?? new Set(),
      hostnames: partial.hostnames ?? current?.hostnames ?? new Set(),
      installations: partial.installations ?? current?.installations ?? [],
      lastUpdated: Date.now()
    };
    this.cache.set(updated);
  }

  /**
   * Check if cache is expired
   */
  private isExpired(lastUpdated: number): boolean {
    return Date.now() - lastUpdated > this.CACHE_TTL_MS;
  }

  /**
   * Get cache status
   */
  getCacheStatus(): { hasData: boolean; isExpired: boolean; isLoading: boolean } {
    const cached = this.cache();
    return {
      hasData: cached !== null,
      isExpired: cached ? this.isExpired(cached.lastUpdated) : true,
      isLoading: this.loading()
    };
  }
}

