# Test-Struktur Empfehlung für Persistence

## Aktuelle Situation

**Code-Struktur:**
```
persistence/
├── file-watcher-manager.mts          (File Watching)
├── application-persistence-handler.mts (Application-Operationen)
├── template-persistence-handler.mts   (Template-Operationen)
├── framework-persistence-handler.mts  (Framework-Operationen)
└── filesystem-persistence.mts         (Orchestrator)
```

**Aktuelle Test-Struktur:**
```
tests/
└── filesystem-persistence.test.mts    (Alle Tests in einer Datei)
```

## Empfohlene Test-Struktur

```
tests/
├── persistence/
│   ├── application-persistence-handler.test.mts  (Unit Tests für Application Handler)
│   ├── template-persistence-handler.test.mts      (Unit Tests für Template Handler)
│   ├── framework-persistence-handler.test.mts    (Unit Tests für Framework Handler)
│   ├── file-watcher-manager.test.mts             (Unit Tests für File Watcher)
│   └── filesystem-persistence.test.mts           (Integration Tests für Orchestrator)
```

## Vorteile

1. **Bessere Testabdeckung:** Jeder Handler wird direkt getestet
2. **Einfachere Fehleridentifikation:** Fehler können direkt einem Handler zugeordnet werden
3. **Entspricht Code-Struktur:** Tests folgen der gleichen Aufteilung wie der Code
4. **Bessere Wartbarkeit:** Kleinere, fokussierte Test-Dateien
5. **Einfachere Entwicklung:** Neue Features können direkt im entsprechenden Handler-Test getestet werden

## Test-Verteilung

### `application-persistence-handler.test.mts`
- `getAllAppNames()`
- `listApplicationsForFrontend()`
- `readApplication()` (inkl. Inheritance, Icons, Templates)
- `readApplicationIcon()`
- `writeApplication()`
- `deleteApplication()`
- Cache-Verhalten (Application-spezifisch)

### `template-persistence-handler.test.mts`
- `resolveTemplatePath()`
- `loadTemplate()`
- `writeTemplate()`
- `deleteTemplate()`
- Template-Cache-Verhalten

### `framework-persistence-handler.test.mts`
- `getAllFrameworkNames()`
- `readFramework()`
- `writeFramework()`
- `deleteFramework()`
- Framework-Cache-Verhalten

### `file-watcher-manager.test.mts`
- File Watcher Initialisierung
- Cache-Invalidation bei Datei-Änderungen
- Debouncing-Verhalten
- Cleanup

### `filesystem-persistence.test.mts` (Integration Tests)
- Delegation an Handler (verifiziert, dass Methoden korrekt weitergeleitet werden)
- `invalidateCache()` (verifiziert, dass alle Handler invalidiert werden)
- `close()` (verifiziert, dass File Watcher geschlossen wird)
- End-to-End Szenarien

## Migration-Strategie

1. **Phase 1:** Neue Test-Dateien erstellen für Handler
2. **Phase 2:** Tests aus `filesystem-persistence.test.mts` in entsprechende Handler-Tests verschieben
3. **Phase 3:** Integration-Tests in `filesystem-persistence.test.mts` belassen
4. **Phase 4:** Alte Tests entfernen, neue Tests verifizieren

## Beispiel-Struktur

```typescript
// tests/persistence/application-persistence-handler.test.mts
import { ApplicationPersistenceHandler } from "@src/persistence/application-persistence-handler.mjs";

describe("ApplicationPersistenceHandler", () => {
  let handler: ApplicationPersistenceHandler;
  // ... setup
  
  describe("getAllAppNames()", () => {
    // Tests für getAllAppNames
  });
  
  describe("readApplication()", () => {
    // Tests für readApplication
  });
  // ...
});

// tests/persistence/filesystem-persistence.test.mts
import { FileSystemPersistence } from "@src/persistence/filesystem-persistence.mjs";

describe("FileSystemPersistence (Integration)", () => {
  let persistence: FileSystemPersistence;
  // ... setup
  
  describe("Delegation", () => {
    it("should delegate getAllAppNames to ApplicationHandler", () => {
      // Verifiziert, dass Delegation funktioniert
    });
  });
  
  describe("invalidateCache()", () => {
    it("should invalidate all handler caches", () => {
      // Verifiziert, dass alle Handler invalidiert werden
    });
  });
  // ...
});
```

