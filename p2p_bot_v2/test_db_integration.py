import asyncio
import sys
import os

# Asegurar que el directorio actual está en el path
sys.path.append(os.getcwd())

from database import P2PDatabase
from bot_p2p_v2 import db, analyze, config, SessionState, session_state

async def test_auto_persist():
    print("Iniciando Auto Test de Persistencia...")
    
    # Configurar para simular oportunidad clara
    # Compra: 10, Venta: 15 (Spread ~50%)
    buys = [{
        "price": 10.0,
        "seller": "TestBuyer",
        "methods": ["banesco"],
        "score": 1000,
        "min": 0,
        "max": 100000
    }]
    sells = [{
        "price": 15.0,
        "seller": "TestSeller",
        "methods": ["banesco"],
        "score": 1000,
        "min": 0,
        "max": 100000
    }]
    
    # Mock de la sesión aiohttp (no se usa realmente para insertar en DB)
    class MockSession:
        async def post(self, *args, **kwargs):
            pass
    
    print("Ejecutando análisis con oportunidad artificial (Spread 50%)...")
    await analyze(MockSession(), buys, sells, "Banesco")
    
    # Verificar base de datos
    records = db.get_last_records(1)
    if not records:
        print("FAIL: No se encontró el registro en la base de datos.")
        sys.exit(1)
    
    last_rec = records[0]
    # Estructura: (timestamp, asset, fiat, price, spread)
    print(f"SUCCESS: Registro encontrado: {last_rec}")
    
    if last_rec[1] == config.asset and last_rec[4] > 40: # Spread esperado > 40%
        print("OK: Validación de datos correcta.")
    else:
        print(f"WARNING: Datos del registro inesperados: {last_rec}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(test_auto_persist())
