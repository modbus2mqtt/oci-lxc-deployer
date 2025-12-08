//

import { ApiUri, ISsh } from '../shared/types';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { IApplicationWeb, IParameter } from '../shared/types';



export interface VeConfigurationParam { name: string; value: string | number | boolean }


@Injectable({
  providedIn: 'root',
})
export class ProxmoxConfigurationService {
  private http = inject(HttpClient);
  private router = inject(Router);

  private static _router: Router;
  static setRouter(router: Router) {
    ProxmoxConfigurationService._router = router;
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
    if (ProxmoxConfigurationService._router) {
      ProxmoxConfigurationService._router.navigate(['/']);
    }
    return throwError(() => err);
  }

  getApplications(): Observable<IApplicationWeb[]> {
    ProxmoxConfigurationService.setRouter(this.router);
    return this.http.get<IApplicationWeb[]>('/api/applications').pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }
  getUnresolvedParameters(application: string, task: string): Observable<{ unresolvedParameters: IParameter[] }> {
    ProxmoxConfigurationService.setRouter(this.router);
    return this.http.get<{ unresolvedParameters: IParameter[] }>(`/api/getUnresolvedParameters/${application}/${task}`).pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }
  getSshConfigs() {
    return this.http.get<ISsh[]>(ApiUri.SshConfigs).pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }

  checkSsh(host: string, port?: number) {
    const params = new URLSearchParams({ host });
    if (typeof port === 'number') params.set('port', String(port));
    return this.http.get<{ permissionOk: boolean }>(`${ApiUri.SshCheck}?${params.toString()}`).pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }

  postProxmoxConfiguration(application: string, task: string, params: VeConfigurationParam[]): Observable<{ success: boolean }> {
    const url = `/api/proxmox-configuration/${encodeURIComponent(application)}/${encodeURIComponent(task)}`;
    return this.http.post<{ success: boolean }>(url, params).pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }

  setSshConfig(ssh: ISsh) {
    return this.http.post<{ success: boolean }>('/api/sshconfig', ssh).pipe(
      catchError(ProxmoxConfigurationService.handleError)
    );
  }
}
