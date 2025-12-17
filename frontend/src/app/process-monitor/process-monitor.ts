import { NgZone, OnDestroy, Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { CommonModule } from '@angular/common';
import { IVeExecuteMessagesResponse, ISingleExecuteMessagesResponse } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [CommonModule, MatTooltipModule, MatExpansionModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IVeExecuteMessagesResponse| undefined;
  private pollInterval?: number;
  private veConfigurationService = inject(VeConfigurationService);
  private router = inject(Router);
  private zone = inject(NgZone);

  ngOnInit() {
    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  startPolling() {
    this.pollInterval = setInterval(() => {
      this.veConfigurationService.getExecuteMessages().subscribe({
        next: (msgs) => {
          if (msgs && msgs.length > 0) {
            this.zone.run(() => {
              this.mergeMessages(msgs);
              this.checkAllFinished();
            });
          }
        },
        error: () => {
          // Optionally handle error
        }
      });
    }, 5000);
  }

  private checkAllFinished() {
    if (!this.messages || this.messages.length === 0) return;
    
    const allFinished = this.messages.every(group => 
      group.messages.some(msg => msg.finished)
    );
    
    if (allFinished) {
      // Navigate to applications list after short delay
      setTimeout(() => {
        this.router.navigate(['/applications']);
      }, 2000);
    }
  }

  private mergeMessages(newMsgs: IVeExecuteMessagesResponse) {
    if (!this.messages) {
      this.messages = [...newMsgs];
      return;
    }
    
    for (const newGroup of newMsgs) {
      const existing = this.messages.find(
        g => g.application === newGroup.application && g.task === newGroup.task
      );
      if (existing) {
        // Append only new messages (by index)
        const existingIndices = new Set(existing.messages.map(m => m.index));
        for (const msg of newGroup.messages) {
          if (!existingIndices.has(msg.index)) {
            existing.messages.push(msg);
          }
        }
      } else {
        // Add new application/task group
        this.messages.push({ ...newGroup });
      }
    }
  }

  hasError(group: ISingleExecuteMessagesResponse): boolean {
    const hasFinished = group.messages.some(msg => msg.finished);
    if (hasFinished) return false;
    return group.messages.some(msg => msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0));
  }

  triggerRestart(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;
    
    this.veConfigurationService.restartExecution(group.restartKey).subscribe({
      next: () => {
        // Clear old messages for this group to show fresh run
        if (this.messages) {
          const idx = this.messages.findIndex(
            g => g.application === group.application && g.task === group.task
          );
          if (idx >= 0) {
            this.messages.splice(idx, 1);
          }
        }
      },
      error: (err) => {
        console.error('Restart failed:', err);
      }
    });
  }

}