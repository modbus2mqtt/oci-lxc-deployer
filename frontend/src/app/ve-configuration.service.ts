//

import { ApiUri, ISsh, IApplicationsResponse, ISshConfigsResponse, ISshConfigKeyResponse, ISshCheckResponse, IUnresolvedParametersResponse, IDeleteSshConfigResponse, IPostVeConfigurationResponse, IPostVeConfigurationBody, IPostSshConfigResponse, IVeExecuteMessagesResponse } from '../shared/types';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { IApplicationWeb, IParameterValue } from '../shared/types';



export interface VeConfigurationParam { name: string; value: IParameterValue }

@Injectable({
  providedIn: 'root',
})
export class VeConfigurationService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private veContextKey?: string;
  // Explicit initializer: call early (e.g., AppComponent.ngOnInit or APP_INITIALIZER)
  initVeContext(): void {
    this.getSshConfigs().subscribe({
      next: () => {
        // veContextKey is set via tap in getSshConfigs
      },
      error: (err) => {
        console.warn('Failed to initialize VE context', err);
      }
    });
  }

  private static _router: Router;
  static setRouter(router: Router) {
    VeConfigurationService._router = router;
  }
  static handleError(err: Error & { error: {error?: string};errors?: Error; status?: number; message?: string }) {
    let msg = '';
    if (err?.errors && Array.isArray(err.errors) && err.errors.length > 0) {
      msg = err.errors.join('\n');
    } else if (err?.errors instanceof Error) {
      msg = err.errors.message;
    } else if (err?.error )
    {
      msg = err.error.error || JSON.stringify(err.error);
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
  post <T, U>(url:string, body:U):Observable<T> {
    return this.http.post<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url, body).pipe(
      catchError(VeConfigurationService.handleError)
    )
  }
  get<T>(url:string):Observable<T> {
    return this.http.get<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url).pipe(
      catchError(VeConfigurationService.handleError)
    )
  }

  getVeContextKey(): string | undefined {
    return this.veContextKey;
  }
  getApplications(): Observable<IApplicationWeb[]> {
    VeConfigurationService.setRouter(this.router);
    return this.get<IApplicationsResponse>(ApiUri.Applications);
  }

  getUnresolvedParameters(application: string, task: string): Observable<IUnresolvedParametersResponse> {
    const base = ApiUri.UnresolvedParameters
      .replace(":application", encodeURIComponent(application))
      .replace(":task", encodeURIComponent(task));
    const url = this.veContextKey ? base.replace(":veContext", this.veContextKey) : base;
    return this.http.get<IUnresolvedParametersResponse>(url);
  }

  getSshConfigs(): Observable<ISsh[]> {
    return this.get<ISshConfigsResponse>(ApiUri.SshConfigs).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      map((res: ISshConfigsResponse) => res.sshs)
    );
  }

  getSshConfigKey(host: string): Observable<ISshConfigKeyResponse> {
    const url = ApiUri.SshConfigGET.replace(':host', encodeURIComponent(host));
    return this.get<ISshConfigKeyResponse>(url).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  checkSsh(host: string, port?: number): Observable<ISshCheckResponse> {
    const params = new URLSearchParams({ host });
    if (typeof port === 'number') params.set('port', String(port));
    return this.get<ISshCheckResponse>(`${ApiUri.SshCheck}?${params.toString()}`);
  }

  postVeConfiguration(application: string, task: string, params: VeConfigurationParam[]): Observable<{ success: boolean; restartKey?: string }> {
    const url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application))
      .replace(':task', encodeURIComponent(task));
    return this.post<IPostVeConfigurationResponse,IPostVeConfigurationBody>(url, { params }).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  setSshConfig(ssh: ISsh): Observable<IPostSshConfigResponse> {
    return this.post<IPostSshConfigResponse, ISsh>(ApiUri.SshConfig, ssh).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError(VeConfigurationService.handleError)
    );
  }

  deleteSshConfig(host: string): Observable<IDeleteSshConfigResponse> {
    const params = new URLSearchParams({ host });
    return this.http.delete<IDeleteSshConfigResponse>(`${ApiUri.SshConfig}?${params.toString()}`).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError(VeConfigurationService.handleError)
    );
  }
  getExecuteMessages(): Observable<IVeExecuteMessagesResponse> {
    return  this.get<IVeExecuteMessagesResponse>(ApiUri.VeExecute);
  }
  
  restartExecution(restartKey: string): Observable<IPostVeConfigurationResponse> {
    if (!this.veContextKey) {
      return throwError(() => new Error("VE context not set"));
    }
    // Note: post() already replaces :veContext, so only replace :restartKey here
    const url = ApiUri.VeRestart.replace(':restartKey', encodeURIComponent(restartKey));
    return this.post<IPostVeConfigurationResponse, object>(url, {});
  }
}
