import { NgZone, OnDestroy, Component, OnInit, inject, Input, Output, EventEmitter } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { MatExpansionModule } from '@angular/material/expansion';
import { IProxmoxExecuteMessage, ApiUri } from '../../shared/types';
import { HttpClient, HttpClientModule } from '@angular/common/http';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [MatExpansionModule, HttpClientModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IProxmoxExecuteMessage[] = [];
  private destroyed = false;
  private pollInterval?: number;
  @Input() restartKey?: string;
  @Output() restartRequested = new EventEmitter<string>();

  private http = inject(HttpClient);
  private zone = inject(NgZone);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    // pick restartKey from query params if present
    const key = this.route.snapshot.queryParamMap.get('restartKey');
    if (key) this.restartKey = key;
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  startPolling() {
    this.pollInterval = setInterval(() => {
      this.http.get<IProxmoxExecuteMessage[]>(ApiUri.VeExecute).subscribe({
        next: (msgs) => {
           if (msgs && msgs.length > 0) {
           console.log('Polled messages:', msgs);
           this.zone.run(() => {
              this.messages = [ ...msgs];
            });
          }
        },
        error: () => {
          // Optionally handle error
        }
      });
    }, 5000);
  }

  triggerRestart() {
    if (this.restartKey) {
      this.restartRequested.emit(this.restartKey);
    }
  }

}