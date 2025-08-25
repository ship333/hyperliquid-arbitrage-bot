/**
 * Production-grade WebSocket Manager for HFT
 * Features:
 * - Connection pooling with automatic failover
 * - Exponential backoff reconnection
 * - Circuit breaker pattern for rate limiting
 * - Ring buffer for low-latency event processing
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface WSConfig {
  url: string;
  name: string;
  priority: number;  // Lower = higher priority
  maxReconnectAttempts?: number;
  reconnectIntervalMs?: number;
  maxReconnectIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface WSMessage {
  type: 'data' | 'error' | 'connected' | 'disconnected';
  source: string;
  timestamp: number;
  data?: any;
  error?: Error;
}

interface ConnectionState {
  ws: WebSocket | null;
  config: WSConfig;
  isConnected: boolean;
  reconnectAttempts: number;
  lastHeartbeat: number;
  messageCount: number;
  errorCount: number;
  latencyMs: number[];  // Ring buffer of last 100 latencies
  reconnectTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
}

export class WebSocketManager extends EventEmitter {
  private connections: Map<string, ConnectionState> = new Map();
  private messageBuffer: WSMessage[] = [];
  private readonly maxBufferSize = 10000;
  private bufferIndex = 0;
  private isShuttingDown = false;
  
  // Circuit breaker
  private requestCount = 0;
  private requestWindow = Date.now();
  private readonly maxRequestsPerSecond = 1000;
  private circuitBreakerTripped = false;

  constructor() {
    super();
    this.setMaxListeners(100);
    
    // Reset request window every second
    setInterval(() => {
      if (Date.now() - this.requestWindow >= 1000) {
        this.requestCount = 0;
        this.requestWindow = Date.now();
        if (this.circuitBreakerTripped) {
          console.log('[WSManager] Circuit breaker reset');
          this.circuitBreakerTripped = false;
        }
      }
    }, 100);
  }

  /**
   * Add a WebSocket connection to the pool
   */
  addConnection(config: WSConfig): void {
    if (this.connections.has(config.name)) {
      console.warn(`[WSManager] Connection ${config.name} already exists`);
      return;
    }

    const state: ConnectionState = {
      ws: null,
      config: {
        maxReconnectAttempts: 10,
        reconnectIntervalMs: 100,
        maxReconnectIntervalMs: 30000,
        heartbeatIntervalMs: 30000,
        requestTimeoutMs: 5000,
        ...config
      },
      isConnected: false,
      reconnectAttempts: 0,
      lastHeartbeat: Date.now(),
      messageCount: 0,
      errorCount: 0,
      latencyMs: []
    };

    this.connections.set(config.name, state);
    this.connect(state);
  }

  /**
   * Connect or reconnect a WebSocket
   */
  private connect(state: ConnectionState): void {
    if (this.isShuttingDown) return;

    try {
      console.log(`[WSManager] Connecting to ${state.config.name}...`);
      
      const ws = new WebSocket(state.config.url, {
        perMessageDeflate: false,  // Disable compression for lower latency
        handshakeTimeout: 5000
      });

      state.ws = ws;

      ws.on('open', () => {
        console.log(`[WSManager] Connected to ${state.config.name}`);
        state.isConnected = true;
        state.reconnectAttempts = 0;
        state.lastHeartbeat = Date.now();
        
        this.emit('connection', {
          type: 'connected',
          source: state.config.name,
          timestamp: Date.now()
        });

        // Start heartbeat
        this.startHeartbeat(state);
      });

      ws.on('message', (data: Buffer) => {
        const receiveTime = Date.now();
        state.messageCount++;
        
        // Check circuit breaker
        if (this.checkCircuitBreaker()) {
          return;
        }

        try {
          const parsed = JSON.parse(data.toString());
          
          // Calculate latency if timestamp in message
          if (parsed.timestamp) {
            const latency = receiveTime - parsed.timestamp;
            state.latencyMs.push(latency);
            if (state.latencyMs.length > 100) {
              state.latencyMs.shift();
            }
          }

          const message: WSMessage = {
            type: 'data',
            source: state.config.name,
            timestamp: receiveTime,
            data: parsed
          };

          // Add to ring buffer
          this.addToBuffer(message);
          
          // Emit for real-time processing
          this.emit('message', message);
          
        } catch (error) {
          state.errorCount++;
          console.error(`[WSManager] Parse error from ${state.config.name}:`, error);
        }
      });

      ws.on('error', (error: Error) => {
        console.error(`[WSManager] Error from ${state.config.name}:`, error.message);
        state.errorCount++;
        
        this.emit('error', {
          type: 'error',
          source: state.config.name,
          timestamp: Date.now(),
          error
        });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[WSManager] Disconnected from ${state.config.name}: ${code} ${reason.toString()}`);
        state.isConnected = false;
        
        this.stopHeartbeat(state);
        
        this.emit('connection', {
          type: 'disconnected',
          source: state.config.name,
          timestamp: Date.now(),
          data: { code, reason: reason.toString() }
        });

        // Attempt reconnection with exponential backoff
        this.scheduleReconnect(state);
      });

      ws.on('ping', () => {
        ws.pong();
        state.lastHeartbeat = Date.now();
      });

    } catch (error) {
      console.error(`[WSManager] Failed to create WebSocket for ${state.config.name}:`, error);
      this.scheduleReconnect(state);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(state: ConnectionState): void {
    if (this.isShuttingDown) return;
    
    const { maxReconnectAttempts, reconnectIntervalMs, maxReconnectIntervalMs } = state.config;
    
    if (state.reconnectAttempts >= (maxReconnectAttempts || 10)) {
      console.error(`[WSManager] Max reconnection attempts reached for ${state.config.name}`);
      this.emit('error', {
        type: 'error',
        source: state.config.name,
        timestamp: Date.now(),
        error: new Error('Max reconnection attempts reached')
      });
      return;
    }

    const backoffMs = Math.min(
      (reconnectIntervalMs || 100) * Math.pow(2, state.reconnectAttempts),
      maxReconnectIntervalMs || 30000
    );

    console.log(`[WSManager] Reconnecting ${state.config.name} in ${backoffMs}ms (attempt ${state.reconnectAttempts + 1})`);
    
    state.reconnectTimer = setTimeout(() => {
      state.reconnectAttempts++;
      this.connect(state);
    }, backoffMs);
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(state: ConnectionState): void {
    const interval = state.config.heartbeatIntervalMs || 30000;
    
    state.heartbeatTimer = setInterval(() => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // Check if we've received data recently
      const timeSinceLastHeartbeat = Date.now() - state.lastHeartbeat;
      if (timeSinceLastHeartbeat > interval * 2) {
        console.warn(`[WSManager] No heartbeat from ${state.config.name} for ${timeSinceLastHeartbeat}ms`);
        state.ws.terminate();
        return;
      }

      // Send ping
      state.ws.ping();
    }, interval);
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(state: ConnectionState): void {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  /**
   * Circuit breaker to prevent overwhelming the system
   */
  private checkCircuitBreaker(): boolean {
    this.requestCount++;
    
    if (this.requestCount > this.maxRequestsPerSecond) {
      if (!this.circuitBreakerTripped) {
        console.error('[WSManager] Circuit breaker tripped! Too many messages per second');
        this.circuitBreakerTripped = true;
        this.emit('error', {
          type: 'error',
          source: 'circuit_breaker',
          timestamp: Date.now(),
          error: new Error('Circuit breaker tripped')
        });
      }
      return true;
    }
    
    return false;
  }

  /**
   * Add message to ring buffer
   */
  private addToBuffer(message: WSMessage): void {
    this.messageBuffer[this.bufferIndex] = message;
    this.bufferIndex = (this.bufferIndex + 1) % this.maxBufferSize;
  }

  /**
   * Send a message to a specific connection
   */
  send(connectionName: string, message: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const state = this.connections.get(connectionName);
      
      if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`Connection ${connectionName} not available`));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Send timeout'));
      }, state.config.requestTimeoutMs || 5000);

      state.ws.send(JSON.stringify(message), (error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get connection statistics
   */
  getStats(): Map<string, any> {
    const stats = new Map();
    
    for (const [name, state] of this.connections) {
      const avgLatency = state.latencyMs.length > 0
        ? state.latencyMs.reduce((a, b) => a + b, 0) / state.latencyMs.length
        : 0;
      
      stats.set(name, {
        isConnected: state.isConnected,
        messageCount: state.messageCount,
        errorCount: state.errorCount,
        reconnectAttempts: state.reconnectAttempts,
        avgLatencyMs: Math.round(avgLatency),
        lastHeartbeat: state.lastHeartbeat
      });
    }
    
    return stats;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('[WSManager] Shutting down...');
    this.isShuttingDown = true;
    
    for (const state of this.connections.values()) {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
      }
      
      this.stopHeartbeat(state);
      
      if (state.ws) {
        state.ws.close(1000, 'Shutdown');
      }
    }
    
    this.connections.clear();
    this.removeAllListeners();
  }
}
