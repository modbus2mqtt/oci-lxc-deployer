//

import { ApiUri, ISsh } from '../shared/types';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { IApplicationWeb, IParameter } from '../shared/types';



export interface VeConfigurationParam { name: string; value: string | number | boolean }

// HTTP response for SSH configs can be either a plain array
// or an object containing the list and an optional key
interface SshConfigsResponse { sshs: ISsh[]; key?: string };


@Injectable({
  providedIn: 'root',
})
export class VeConfigurationService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private veContextKey?: string;

  private static _router: Router;
  static setRouter(router: Router) {
    VeConfigurationService._router = router;
  }
  static handleError(err: Error & { errors?: Error; status?: number; message?: string }) {
    let msg = '';
    if (err?.errors && Array.isArray(err.errors) && err.errors.length > 0) {
      msg = err.errors.join('\n');
    } else if (err?.errors instanceof Error) {
      msg = err.errors.message;
    } else if (err?.message) {
      msg = err.message;
    } else if (err?.status) {
      msg = `Http Error status code: ${err.status}`;
    } else {
      msg = 'Unknown error';
    }
    alert(msg);
    if (VeConfigurationService._router) {
      VeConfigurationService._router.navigate(['/']);
    }
    return throwError(() => err);
  }

  // Track VE context key returned by backend so we can append it to future calls when required
  private setVeContextKeyFrom(response: unknown) {
    if (response && typeof response === 'object') {
      const obj = response as Record<string, unknown>;
      const keyVal = obj['key'];
      if (typeof keyVal === 'string' && keyVal.length > 0) {
        this.veContextKey = keyVal;
      }
    }
  }

  getVeContextKey(): string | undefined {
    return this.veContextKey;
  }

  withVeContextKey(url: string): string {
    if (!this.veContextKey) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}key=${encodeURIComponent(this.veContextKey)}`;
  }

  getApplications(): Observable<IApplicationWeb[]> {
    VeConfigurationService.setRouter(this.router);
      return this.http.get<IApplicationWeb[]>(ApiUri.Applications).pipe(
      catchError(VeConfigurationService.handleError)
    );
  }
  getUnresolvedParameters(application: string, task: string): Observable<{ unresolvedParameters: IParameter[] }> {
    VeConfigurationService.setRouter(this.router);
      const url = ApiUri.UnresolvedParameters
        .replace(':application', encodeURIComponent(application))
        .replace(':task', encodeURIComponent(task));
      return this.http.get<{ unresolvedParameters: IParameter[] }>(url).pipe(
      catchError(VeConfigurationService.handleError)
    );
  }
  getSshConfigs(): Observable<ISsh[]> {
    return this.http.get<SshConfigsResponse>(ApiUri.SshConfigs).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      map((res: SshConfigsResponse) => res.sshs),
      catchError(VeConfigurationService.handleError)
    );
  }

  checkSsh(host: string, port?: number) {
    const params = new URLSearchParams({ host });
    if (typeof port === 'number') params.set('port', String(port));
    return this.http.get<{ permissionOk: boolean; stderr?: string }>(`${ApiUri.SshCheck}?${params.toString()}`).pipe(
      catchError(VeConfigurationService.handleError)
    );
  }

  postVeConfiguration(application: string, task: string, params: VeConfigurationParam[], restartKey?: string): Observable<{ success: boolean; restartKey?: string }> {
    let url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application))
      .replace(':task', encodeURIComponent(task));
    const qp = new URLSearchParams();
    const veKey = this.getVeContextKey();
    if (veKey) qp.set('veContext', veKey);
    if (restartKey) qp.set('restartKey', restartKey);
    if ([...qp.keys()].length > 0) url = `${url}?${qp.toString()}`;
    return this.http.post<{ success: boolean; restartKey?: string }>(url, params).pipe(
      catchError(VeConfigurationService.handleError)
    );
  }

  setSshConfig(ssh: ISsh): Observable<{ success: boolean; key?: string }> {
    return this.http.post<{ success: boolean; key?: string }>(ApiUri.SshConfig, ssh).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError(VeConfigurationService.handleError)
    );
  }

  deleteSshConfig(host: string): Observable<{ success: boolean; deleted?: boolean; key?: string }> {
    const params = new URLSearchParams({ host });
      return this.http.delete<{ success: boolean; deleted?: boolean; key?: string }>(`${ApiUri.SshConfig}?${params.toString()}`).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError(VeConfigurationService.handleError)
    );
  }
}
