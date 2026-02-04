# Refactoring Plan: create-application.ts aufteilen

## Nächste Phase starten

Um die nächste Phase in einer neuen Claude-Session zu starten:

```bash
Lies docs/refactor-create-application.md und führe Phase 3 aus.
```

**Relevante Dateien für Phase 3:**
- `frontend/src/app/create-application/create-application.ts` - Hauptkomponente (Tags-Methoden extrahieren)
- `frontend/src/app/create-application/create-application.html` - Template (Tags-HTML extrahieren)
- `frontend/src/app/create-application/services/create-application-state.service.ts` - State Service (Tags-Signals/Methoden)
- `frontend/src/app/create-application/components/icon-upload.component.ts` - Pattern-Vorlage für neue Komponente

**Verifizierung nach Abschluss:**
```bash
./frontend/scripts/verify-build.sh
```

---

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

## Test-Script

Nach jeder Phase das Verifikations-Script ausführen:

```bash
./frontend/scripts/verify-build.sh
```

Das Script führt automatisch aus:
1. `pnpm run lint:fix` - Lint-Fehler beheben
2. `pnpm run build` - Build verifizieren
3. `pnpm test` - Tests ausführen

---

## Phasen-Plan (9 Schritte)

### Phase 1: State Service erstellen (Fundament) ✅ ABGESCHLOSSEN

**Ziel:** Gemeinsamen State in einen Service extrahieren

**Neue Datei:** `services/create-application-state.service.ts`

**Was wurde verschoben:**
- Alle Signals: `editMode`, `imageReference`, `parsedComposeData`, etc.
- Forms: `appPropertiesForm`, `parameterForm`
- Compose-State: `composeServices`, `requiredEnvVars`, `missingEnvVars`
- Helper-Methoden: `isOciImageFramework()`, `isDockerComposeFramework()`, `isOciComposeMode()`, `toggleTag()`, `isTagSelected()`, `reset()`, `clearError()`

**Änderungen an create-application.ts:**
- State Service wird injiziert: `readonly state = inject(CreateApplicationStateService)`
- Alle Signals werden über Getter/Setter an den State Service delegiert

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 2: Icon Upload Component ✅ ABGESCHLOSSEN

**Ziel:** Erste kleine Komponente extrahieren

**Neue Datei:** `components/icon-upload.component.ts`

**Was wurde verschoben aus create-application.ts:**
- `onIconFileSelected()` → `onFileSelected()` in IconUploadComponent
- `removeIcon()` → `onRemoveIcon()` in IconUploadComponent
- `openIconFileDialog()` → `openFileDialog()` in IconUploadComponent
- `resetIconFileInput()` → `resetFileInput()` in IconUploadComponent

**Was wurde verschoben aus create-application.html:**
- Icon-Upload Section (25 Zeilen) → Template in IconUploadComponent

**Änderungen an create-application.ts:**
- Import `IconUploadComponent` und `IconSelectedEvent` hinzugefügt
- `IconUploadComponent` zu imports-Array hinzugefügt
- Neue Event-Handler: `onIconSelected(event)`, `onIconRemoved()`
- Alte Methoden entfernt (ca. 45 Zeilen reduziert)

**Änderungen an create-application.html:**
- Icon-Upload Section ersetzt durch: `<app-icon-upload [iconPreview]="iconPreview()" (iconSelected)="onIconSelected($event)" (iconRemoved)="onIconRemoved()"></app-icon-upload>`

**Verifizierung:** `./frontend/scripts/verify-build.sh` ✅ (Lint ✅, Build ✅, 63 Tests ✅)

---

### Phase 3: Tags Selector Component ⏳ NÄCHSTE PHASE

**Ziel:** Zweite kleine Komponente extrahieren

**Neue Datei:** `components/tags-selector.component.ts`

**Was wird verschoben (aus State Service):**
- `toggleTag()`
- `isTagSelected()`

**Interface:**
```typescript
tagsConfig = input<ITagsConfig | null>(null);
selectedTags = input<string[]>([]);
@Output() tagToggled = new EventEmitter<string>();
```

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 4: App Properties Step (Step 2)

**Ziel:** Step 2 als eigene Komponente

**Neue Datei:** `steps/app-properties-step.component.ts`

**Was wird verschoben:**
- Application ID Validierung
- Template-Teil für Step 2
- Integration von IconUpload und TagsSelector

**Interface:**
```typescript
// Nutzt StateService für Form
get appPropertiesForm() { return this.stateService.appPropertiesForm; }
```

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 5: Framework Step (Step 1)

**Ziel:** Step 1 als eigene Komponente

**Neue Datei:** `steps/framework-step.component.ts`

**Was wird verschoben:**
- `loadFrameworks()`
- `onFrameworkSelected()`
- `setOciInstallMode()`
- `onServiceSelected()`
- Framework-Helper: `isOciImageFramework()`, `isDockerComposeFramework()`, `isOciComposeMode()`
- Template-Teil für Step 1

**Interface:**
```typescript
@Output() frameworkSelected = new EventEmitter<string>();
@Output() composeFileSelected = new EventEmitter<File>();
@Output() envFileSelected = new EventEmitter<File>();
@Output() serviceSelected = new EventEmitter<string>();
```

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 6: Parameters Step (Step 3)

**Ziel:** Step 3 als eigene Komponente

**Neue Datei:** `steps/parameters-step.component.ts`

**Was wird verschoben:**
- `loadParameters()`
- `setupParameterForm()`
- Volume-Storage-Validierung
- Env-File-Requirement
- `toggleAdvanced()`, `hasAdvancedParams()`, `groupNames`
- Template-Teil für Step 3

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 7: Summary Step (Step 4)

**Ziel:** Step 4 als eigene Komponente

**Neue Datei:** `steps/summary-step.component.ts`

**Was wird verschoben:**
- `createApplication()`
- `navigateToErrorStep()`
- `clearError()`
- Template-Teil für Step 4

**Interface:**
```typescript
@Output() navigateToStep = new EventEmitter<number>();
@Output() applicationCreated = new EventEmitter<void>();
```

**Verifizierung:** `./frontend/scripts/verify-build.sh`

---

### Phase 8: Compose/Image Logik in State Service

**Ziel:** Komplexe Integration-Logik in Service verschieben

**Was wird in StateService verschoben:**
- `onComposeFileSelected()`
- `onEnvFileSelected()`
- `fetchImageAnnotations()`
- `fillFieldsFromAnnotations()`
- `updateImageFromCompose()`
- `updateInitialCommandFromCompose()`
- `updateUserFromCompose()`
- `fillEnvsForSelectedService()`

**Verifizierung:** `./frontend/scripts/verify-build.sh`

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

**Verifizierung:** `./frontend/scripts/verify-build.sh`

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
