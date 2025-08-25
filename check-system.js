/**
 * Simple JavaScript System Check
 * No TypeScript compilation needed
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Hyperliquid Arbitrage Bot - System Check\n');
console.log('='.repeat(50));

// Check critical files exist
const criticalFiles = [
  // Core Components
  { path: 'src/risk/RiskManager.ts', name: 'Risk Manager' },
  { path: 'src/risk/PositionMonitor.ts', name: 'Position Monitor' },
  { path: 'src/integration/SignalBridge.ts', name: 'Signal Bridge' },
  { path: 'src/integration/main.ts', name: 'Main Integration' },
  
  // Monitoring
  { path: 'src/monitoring/MetricsCollector.ts', name: 'Metrics Collector' },
  { path: 'src/monitoring/dashboard.ts', name: 'Dashboard' },
  
  // Configuration
  { path: '.env', name: 'Environment Config' },
  { path: '.env.execution', name: 'Execution Config' },
  
  // Docker
  { path: 'Dockerfile', name: 'Dockerfile' },
  { path: 'docker-compose.yml', name: 'Docker Compose' },
  { path: 'prometheus.yml', name: 'Prometheus Config' }
];

let allFilesExist = true;
console.log('📁 Checking Critical Files:\n');

criticalFiles.forEach(file => {
  const fullPath = path.join(__dirname, file.path);
  const exists = fs.existsSync(fullPath);
  console.log(`  ${exists ? '✅' : '❌'} ${file.name.padEnd(25)} - ${file.path}`);
  if (!exists) allFilesExist = false;
});

// Check package dependencies
console.log('\n📦 Checking Dependencies:\n');
try {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const requiredDeps = [
    'express',
    'ws',
    'winston',
    'prom-client',
    'dotenv',
    'ethers',
    'viem'
  ];
  
  requiredDeps.forEach(dep => {
    const installed = packageJson.dependencies[dep] || packageJson.devDependencies[dep];
    console.log(`  ${installed ? '✅' : '❌'} ${dep.padEnd(15)} ${installed ? `(${installed})` : '- NOT FOUND'}`);
  });
} catch (error) {
  console.log('  ❌ Could not read package.json');
}

// Check monitoring dashboard
console.log('\n🖥️  Checking Services:\n');

const http = require('http');

// Check dashboard
const checkDashboard = new Promise((resolve) => {
  http.get('http://localhost:4000/api/health', (res) => {
    if (res.statusCode === 200) {
      console.log('  ✅ Monitoring Dashboard   - RUNNING on port 4000');
      resolve(true);
    } else {
      console.log('  ❌ Monitoring Dashboard   - NOT RESPONDING');
      resolve(false);
    }
  }).on('error', () => {
    console.log('  ⚠️  Monitoring Dashboard   - NOT RUNNING (start with: npm run monitor)');
    resolve(false);
  });
});

// Run checks
Promise.all([checkDashboard]).then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('📊 SYSTEM STATUS SUMMARY\n');
  
  if (allFilesExist) {
    console.log('✅ All critical files present');
  } else {
    console.log('⚠️  Some files missing - check above');
  }
  
  console.log('\n🎯 NEXT STEPS:\n');
  console.log('1. Start monitoring dashboard:');
  console.log('   npm run monitor\n');
  console.log('2. Run in dry-run mode:');
  console.log('   BOT_MODE=dry-run npm run start:integration\n');
  console.log('3. Deploy with Docker:');
  console.log('   docker-compose up --build\n');
  
  console.log('📚 Full documentation: PRODUCTION_README.md');
  console.log('='.repeat(50));
});
