
import { Routes } from '@angular/router';
import { Home } from './home/home';
import { ApplicationsList } from './applications-list/applications-list';
import { ProcessMonitor } from './process-monitor/process-monitor';
import { SshConfigPage } from './ssh-config-page/ssh-config-page';
import { CreateApplication } from './create-application/create-application';
import { InstalledList } from './installed-list/installed-list';
import { StacksPage } from './stacks-page/stacks-page';

export const routes: Routes = [
	{ path: '', component: ApplicationsList },
	{ path: 'applications', component: ApplicationsList },
	{ path: 'home', component: Home },
	{ path: 'monitor', component: ProcessMonitor },
  { path: 'ssh-config', component: SshConfigPage },
  { path: 'create-application', component: CreateApplication },
	{ path: 'installations', component: InstalledList },
  { path: 'stacks', component: StacksPage },
];
