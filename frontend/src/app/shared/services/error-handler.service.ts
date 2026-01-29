import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { IJsonError } from '../../../shared/types';
import { ErrorDialog } from '../../applications-list/error-dialog';

@Injectable({ providedIn: 'root' })
export class ErrorHandlerService {
  private dialog = inject(MatDialog);

  /**
   * Handles an error by converting it to IJsonError[] and optionally showing a dialog.
   * @param prefix Prefix for the error message
   * @param err The error to handle
   * @param showDialog Whether to automatically show the error dialog (default: true)
   * @returns Array of IJsonError objects
   */
  handleError(prefix: string, err: unknown, showDialog = true): IJsonError[] {
    const errors = this.convertErrorToJsonErrors(prefix, err);
    if (showDialog) {
      this.showErrorDialog(errors);
    }
    return errors;
  }

  /**
   * Converts an error to IJsonError[] without showing a dialog.
   * @param prefix Prefix for the error message
   * @param err The error to convert
   * @returns Array of IJsonError objects
   */
  convertError(prefix: string, err: unknown): IJsonError[] {
    return this.convertErrorToJsonErrors(prefix, err);
  }

  /**
   * Shows an error dialog with the given errors.
   * @param errors Array of IJsonError objects to display
   */
  showErrorDialog(errors: IJsonError[]): void {
    this.dialog.open(ErrorDialog, { 
      data: { errors }, 
      panelClass: 'error-dialog-panel' 
    });
  }

  /**
   * Converts various error formats to IJsonError[].
   * Handles HTTP errors, nested errors, and different error structures.
   */
  private convertErrorToJsonErrors(prefix: string, err: unknown): IJsonError[] {
    if (!err) {
      return [{
        name: 'Error',
        message: prefix,
        details: undefined
      } as IJsonError];
    }

    try {
      const errObj = err as Record<string, unknown>;
      // HTTP errors from Angular HttpClient have the response body in the 'error' property
      // Backend returns: { success: false, error: <error message>, errorDetails: <error object> }
      const errorBody = errObj['error'] as Record<string, unknown> | string | undefined;
      
      // Handle case where errorBody is an object (from HTTP error response)
      if (errorBody && typeof errorBody === 'object') {
        // First, check for errorDetails (VE routes use this)
        const errorDetails = errorBody['errorDetails'] as Record<string, unknown> | undefined;
        if (errorDetails && typeof errorDetails === 'object') {
          const name = (errorDetails['name'] as string) || 'Error';
          const message = (errorDetails['message'] as string) || '';
          const details = errorDetails['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Check for serializedError (legacy support for other routes)
        const serializedError = errorBody['serializedError'];
        if (serializedError && typeof serializedError === 'object') {
          const name = ((serializedError as Record<string, unknown>)['name'] as string) || 'Error';
          const message = ((serializedError as Record<string, unknown>)['message'] as string) || '';
      
          const details = (serializedError as Record<string, unknown>)['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Check if errorBody has nested 'error' property (from backend response structure)
        const nestedError = errorBody['error'] as Record<string, unknown> | undefined;
        
        // If nested error exists and is an object, use it (this is the actual error structure)
        if (nestedError && typeof nestedError === 'object') {
          const name = (nestedError['name'] as string) || 'Error';
          const message = (nestedError['message'] as string) || '';
          const details = nestedError['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // If errorBody itself has name/message/details (direct error object), use it
        if (errorBody['name'] || errorBody['message']) {
          const name = (errorBody['name'] as string) || 'Error';
          const message = (errorBody['message'] as string) || '';
          const details = errorBody['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Handle case where errorBody.error is a string (but only if errorDetails was not found)
        // This should be checked AFTER errorDetails to avoid overriding detailed errors
        const errorMessage = errorBody['error'];
        if (typeof errorMessage === 'string' && errorMessage.length > 0) {
          // Only use this as fallback if we haven't already found errorDetails
          // This prevents script output from overriding validation errors
          return [{
            name: 'Error',
            message: `${prefix}: ${errorMessage}`,
            details: undefined
          } as IJsonError];
        }
        
        // Fallback: stringify the error body
        return [{
          name: 'Error',
          message: `${prefix}: ${JSON.stringify(errorBody)}`,
          details: undefined
        } as IJsonError];
      }
      
      // Handle case where errorBody is a string directly
      if (typeof errorBody === 'string') {
        return [{
          name: 'Error',
          message: `${prefix}: ${errorBody}`,
          details: undefined
        } as IJsonError];
      }
      
      // Handle case where err has a message property (direct Error object)
      if (errObj['message']) {
        return [{
          name: 'Error',
          message: `${prefix}: ${errObj['message']}`,
          details: undefined
        } as IJsonError];
      }
      
      // Final fallback
      return [{
        name: 'Error',
        message: `${prefix}: ${JSON.stringify(err)}`,
        details: undefined
      } as IJsonError];
    } catch {
      return [{
        name: 'Error',
        message: `${prefix}: ${String(err)}`,
        details: undefined
      } as IJsonError];
    }
  }

  /**
   * Converts a details array (which can be nested) to IJsonError[].
   * Handles both flat arrays and nested structures recursively.
   */
  private convertDetailsArray(details: unknown): IJsonError[] | undefined {
    if (!details) {
      return undefined;
    }

    const convertOne = (detail: unknown): IJsonError => {
      if (!detail || typeof detail !== 'object') {
        return {
          name: 'Error',
          message: String(detail),
          details: undefined
        } as IJsonError;
      }

      const detailObj = detail as Record<string, unknown>;
      const nestedDetails = detailObj['details'];

      return {
        name: (detailObj['name'] as string) || 'Error',
        message: (detailObj['message'] as string) || JSON.stringify(detailObj),
        line: detailObj['line'] as number | undefined,
        details: this.convertDetailsArray(nestedDetails)
      } as IJsonError;
    };

    if (Array.isArray(details)) {
      if (details.length === 0) {
        return undefined;
      }
      return details.map(convertOne);
    }

    // Handle single detail object by wrapping it
    if (typeof details === 'object') {
      return [convertOne(details)];
    }

    return undefined;
  }
}

