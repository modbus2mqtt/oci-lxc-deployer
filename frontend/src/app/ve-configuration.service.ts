//

import { ApiUri, ISsh, IApplicationsResponse, ISshConfigsResponse, ISshConfigKeyResponse, ISshCheckResponse, IUnresolvedParametersResponse, IDeleteSshConfigResponse, IPostVeConfigurationResponse, IPostVeConfigurationBody, IPostSshConfigResponse, IVeExecuteMessagesResponse, IFrameworkNamesResponse, IFrameworkParametersResponse, IPostFrameworkCreateApplicationBody, IPostFrameworkCreateApplicationResponse, IPostFrameworkFromImageBody, IPostFrameworkFromImageResponse, IInstallationsResponse } from '../shared/types';
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
  initVeContext(): Observable<ISsh[]> {
    return this.getSshConfigs().pipe(
      map((res: ISshConfigsResponse) => res.sshs)
    );
  }

  private static _router: Router;
  static setRouter(router: Router) {
    VeConfigurationService._router = router;
  }
  static handleError(err: Error & { error: {error?: string; serializedError?: unknown};errors?: Error; status?: number; message?: string }) {
    // Log serializedError to console if available
    if (err?.error && typeof err.error === 'object' && 'serializedError' in err.error) {
      console.error('Serialized Error:', err.error.serializedError);
    }
    
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
  
  // Post without global error handling - caller must handle errors
  postWithoutGlobalErrorHandler<T, U>(url:string, body:U):Observable<T> {
    return this.http.post<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url, body);
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
    return this.http.get<IApplicationsResponse>(ApiUri.Applications);
  }
  getInstallations(): Observable<IInstallationsResponse> {
    VeConfigurationService.setRouter(this.router);
    return this.get<IInstallationsResponse>(ApiUri.Installations);
  }

  getUnresolvedParameters(application: string, task: string): Observable<IUnresolvedParametersResponse> {
    const base = ApiUri.UnresolvedParameters
      .replace(":application", encodeURIComponent(application))
      .replace(":task", encodeURIComponent(task));
    const url = this.veContextKey ? base.replace(":veContext", this.veContextKey) : base;
    return this.http.get<IUnresolvedParametersResponse>(url);
  }

  getSshConfigs(): Observable<ISshConfigsResponse> {
    return this.get<ISshConfigsResponse>(ApiUri.SshConfigs).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
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

  postVeConfiguration(application: string, task: string, params: VeConfigurationParam[], changedParams?: VeConfigurationParam[]): Observable<{ success: boolean; restartKey?: string; vmInstallKey?: string }> {
    const url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application))
      .replace(':task', encodeURIComponent(task));
    const body: IPostVeConfigurationBody = { params };
    if (changedParams && changedParams.length > 0) {
      body.changedParams = changedParams;
    }
    return this.post<IPostVeConfigurationResponse,IPostVeConfigurationBody>(url, body).pipe(
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
    // Parameters are contained in the restart context, no need to send them
    const url = ApiUri.VeRestart.replace(':restartKey', encodeURIComponent(restartKey));
    return this.post<IPostVeConfigurationResponse, object>(url, {});
  }

  restartInstallation(vmInstallKey: string): Observable<IPostVeConfigurationResponse> {
    if (!this.veContextKey) {
      return throwError(() => new Error("VE context not set"));
    }
    // Note: post() already replaces :veContext, so only replace :vmInstallKey here
    const url = ApiUri.VeRestartInstallation.replace(':vmInstallKey', encodeURIComponent(vmInstallKey));
    return this.post<IPostVeConfigurationResponse, object>(url, {}).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  getFrameworkNames(): Observable<IFrameworkNamesResponse> {
    return this.get<IFrameworkNamesResponse>(ApiUri.FrameworkNames);
  }

  getFrameworkParameters(frameworkId: string): Observable<IFrameworkParametersResponse> {
    const url = ApiUri.FrameworkParameters.replace(':frameworkId', encodeURIComponent(frameworkId));
    return this.get<IFrameworkParametersResponse>(url);
  }

  createApplicationFromFramework(body: IPostFrameworkCreateApplicationBody): Observable<IPostFrameworkCreateApplicationResponse> {
    // Use http.post directly to avoid catchError in post() method
    // This allows the component to handle errors itself
    const url = this.veContextKey 
      ? ApiUri.FrameworkCreateApplication.replace(":veContext", this.veContextKey) 
      : ApiUri.FrameworkCreateApplication;
    return this.http.post<IPostFrameworkCreateApplicationResponse>(url, body);
  }

  getFrameworkFromImage(body: IPostFrameworkFromImageBody): Observable<IPostFrameworkFromImageResponse> {
    // Use postWithoutGlobalErrorHandler to allow caller to handle errors (e.g., for debounced input validation)
    return this.postWithoutGlobalErrorHandler<IPostFrameworkFromImageResponse, IPostFrameworkFromImageBody>(ApiUri.FrameworkFromImage, body);
  }
}
