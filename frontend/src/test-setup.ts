// Vitest + Angular TestBed setup
import 'zone.js';
import 'zone.js/testing';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

// Initialize Angular testing environment for TestBed
try {
  getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  console.log('[vitest-setup] Angular TestBed initialized');
} catch {
  // ignore if already initialized by another test file
}

// Helper can be called from specs to ensure init order without importing deprecated symbols there
export function ensureAngularTesting(): void {
	try {
		getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
	} catch {
		// already initialized
	}
}
