# Refactoring Plan: create-application.ts aufteilen

## Ziel

`create-application.ts` (1370 Zeilen) in kleinere Komponenten aufteilen (max. 500-600 Zeilen).

## Zielstruktur

```
create-application/
├── create-application.ts                    # Orchestrator (~450 Zeilen)
├── create-application.html                  # Vereinfachtes Template (~100 Zeilen)
├── services/
│   └── create-application-state.service.ts  # Shared State (~350 Zeilen)
├── steps/
│   ├── framework-step.component.ts          # Step 1 (~300 Zeilen)
│   ├── app-properties-step.component.ts     # Step 2 (~400 Zeilen)
│   ├── parameters-step.component.ts         # Step 3 (~350 Zeilen)
│   └── summary-step.component.ts            # Step 4 (~250 Zeilen)
├── components/
│   ├── icon-upload.component.ts             # Reusable (~100 Zeilen)
│   └── tags-selector.component.ts           # Reusable (~80 Zeilen)
└── oci-image-step.component.ts              # Existiert bereits (147 Zeilen)
```

---

## Phasen-Plan (9 Schritte)

### Phase 1: State Service erstellen (Fundament)

**Ziel:** Gemeinsamen State in einen Service extrahieren

**Neue Datei:** `services/create-application-state.service.ts`

**Was wird verschoben:**
- Alle Signals (Zeilen 72-145): `editMode`, `imageReference`, `parsedComposeData`, etc.
- Forms: `appPropertiesForm`, `parameterForm`
- Compose-State: `composeServices`, `requiredEnvVars`, `missingEnvVars`

**Pattern (wie CacheService):**
```typescript
@Injectable({ providedIn: 'root' })
export class CreateApplicationStateService {
  // Signals
  editMode = signal(false);
  selectedFramework = signal<IFrameworkName | null>(null);
  imageReference = signal('');
  // ... weitere Signals

  // Forms
  appPropertiesForm: FormGroup;
  parameterForm: FormGroup;

  // Methoden
  reset(): void { ... }
}
```

**Test:** `npm run build && npm test`

---

### Phase 2: Icon Upload Component

**Ziel:** Erste kleine Komponente extrahieren

**Neue Datei:** `components/icon-upload.component.ts`

**Was wird verschoben (Zeilen 831-882):**
- `onIconFileSelected()`
- `removeIcon()`
- `openIconFileDialog()`
- `resetIconFileInput()`

**Interface:**
```typescript
@Input() iconPreview: Signal<string | null>;
@Output() iconSelected = new EventEmitter<{file: File, content: string, preview: string}>();
@Output() iconRemoved = new EventEmitter<void>();
```

**Test:** Unit-Test für IconUploadComponent + Integration-Tests

---

### Phase 3: Tags Selector Component

**Ziel:** Zweite kleine Komponente extrahieren

**Neue Datei:** `components/tags-selector.component.ts`

**Was wird verschoben (Zeilen 220-242):**
- `toggleTag()`
- `isTagSelected()`

**Interface:**
```typescript
tagsConfig = input<ITagsConfig | null>(null);
selectedTags = input<string[]>([]);
@Output() tagToggled = new EventEmitter<string>();
```

---

### Phase 4: App Properties Step (Step 2)

**Ziel:** Step 2 als eigene Komponente

**Neue Datei:** `steps/app-properties-step.component.ts`

**Was wird verschoben:**
- Application ID Validierung (Zeilen 750-807)
- Template-Teil (create-application.html Zeilen 83-200)
- Integration von IconUpload und TagsSelector

**Interface:**
```typescript
// Nutzt StateService für Form
get appPropertiesForm() { return this.stateService.appPropertiesForm; }
```

---

### Phase 5: Framework Step (Step 1)

**Ziel:** Step 1 als eigene Komponente

**Neue Datei:** `steps/framework-step.component.ts`

**Was wird verschoben:**
- `loadFrameworks()` (Zeilen 196-218)
- `onFrameworkSelected()` (Zeilen 383-407)
- `setOciInstallMode()` (Zeilen 409-421)
- `onServiceSelected()` (Zeilen 423-432)
- Framework-Helper: `isOciImageFramework()`, `isDockerComposeFramework()`, `isOciComposeMode()`
- Template-Teil (create-application.html Zeilen 8-81)

**Interface:**
```typescript
@Output() frameworkSelected = new EventEmitter<string>();
@Output() composeFileSelected = new EventEmitter<File>();
@Output() envFileSelected = new EventEmitter<File>();
@Output() serviceSelected = new EventEmitter<string>();
```

---

### Phase 6: Parameters Step (Step 3)

**Ziel:** Step 3 als eigene Komponente

**Neue Datei:** `steps/parameters-step.component.ts`

**Was wird verschoben:**
- `loadParameters()` (Zeilen 434-509)
- `setupParameterForm()` (Zeilen 342-381)
- Volume-Storage-Validierung (Zeilen 1029-1066)
- Env-File-Requirement (Zeilen 1068-1108)
- `toggleAdvanced()`, `hasAdvancedParams()`, `groupNames`
- Template-Teil (create-application.html Zeilen 202-237)

---

### Phase 7: Summary Step (Step 4)

**Ziel:** Step 4 als eigene Komponente

**Neue Datei:** `steps/summary-step.component.ts`

**Was wird verschoben:**
- `createApplication()` (Zeilen 595-711)
- `navigateToErrorStep()` (Zeilen 713-732)
- `clearError()` (Zeilen 734-737)
- Template-Teil (create-application.html Zeilen 239-329)

**Interface:**
```typescript
@Output() navigateToStep = new EventEmitter<number>();
@Output() applicationCreated = new EventEmitter<void>();
```

---

### Phase 8: Compose/Image Logik in State Service

**Ziel:** Komplexe Integration-Logik in Service verschieben

**Was wird in StateService verschoben:**
- `onComposeFileSelected()` (Zeilen 941-976)
- `onEnvFileSelected()` (Zeilen 978-994)
- `fetchImageAnnotations()` (Zeilen 1113-1148)
- `fillFieldsFromAnnotations()` (Zeilen 1151-1186)
- `updateImageFromCompose()` (Zeilen 1189-1216)
- `updateInitialCommandFromCompose()` (Zeilen 1218-1240)
- `updateUserFromCompose()` (Zeilen 1248-1287)
- `fillEnvsForSelectedService()` (Zeilen 1298-1320)

---

### Phase 9: Orchestrator finalisieren

**Ziel:** Haupt-Komponente auf ~450 Zeilen reduzieren

**Verbleibende Aufgaben in create-application.ts:**
- Stepper-Koordination
- `ngOnInit`/`ngOnDestroy`
- Edit-Mode-Handling via Route-Params
- `canProceedToStep*()` Methoden
- `onStepChange()`
- `cancel()`

---

## Kritische Dateien

| Datei | Aktion |
|-------|--------|
| `frontend/src/app/create-application/create-application.ts` | Quelle (aufteilen) |
| `frontend/src/app/create-application/create-application.html` | Template (aufteilen) |
| `frontend/src/app/create-application/create-application.integration.vitest.spec.ts` | Tests (erweitern) |
| `frontend/src/app/create-application/oci-image-step.component.ts` | Pattern-Vorlage |
| `frontend/src/app/shared/services/cache.service.ts` | Pattern für State-Service |

---

## Existierende Patterns (wiederverwenden)

1. **Standalone Components** mit `@Input()` Signals und `@Output()` EventEmitters
2. **FormGroup Pass-Through**: Parent besitzt Forms, Children nutzen sie
3. **Signal-Input API**: `input<T>()` für reaktive Inputs
4. **State Service mit Signals**: Wie `CacheService`

---

## Test-Strategie

Nach jeder Phase:
```bash
cd frontend && npm run lint:fix && npm run build && npm test
```

**Bestehende Tests müssen bestehen bleiben:**
- `create-application.integration.vitest.spec.ts` (340 Zeilen)
- `docker-compose-step.component.vitest.spec.ts` (231 Zeilen)

**Neue Tests für jede Komponente:**
- Unit-Tests für isolierte Funktionalität
- Integration-Tests für Komponenten-Kommunikation

---

## Rollback-Strategie

- Git-Commit nach jeder erfolgreichen Phase
- Bei Fehlern: `git reset --hard` zum letzten funktionierenden Commit
- Keine Feature-Flags nötig - jede Phase ist atomar

---

## Ergebnis

| Komponente | Zeilen | Verantwortung |
|------------|--------|---------------|
| `create-application.ts` | ~450 | Orchestrator |
| `create-application-state.service.ts` | ~350 | Shared State |
| `framework-step.component.ts` | ~300 | Step 1 |
| `app-properties-step.component.ts` | ~400 | Step 2 |
| `parameters-step.component.ts` | ~350 | Step 3 |
| `summary-step.component.ts` | ~250 | Step 4 |
| `icon-upload.component.ts` | ~100 | Icon-Upload |
| `tags-selector.component.ts` | ~80 | Tags-Auswahl |

**Alle Komponenten unter 500 Zeilen**
