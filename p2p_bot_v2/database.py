import sqlite3
import logging
from datetime import datetime
from typing import List, Tuple

# Configuración de logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class P2PDatabase:
    """
    Clase para gestionar la persistencia del historial del mercado P2P.
    Utiliza sqlite3 para almacenar datos de precios y spreads.
    """
    def __init__(self, db_name: str = "p2p_bot.db"):
        self.db_name = db_name
        self._create_table()

    def _get_connection(self):
        """Retorna una conexión a la base de datos con soporte para tipos de Python."""
        return sqlite3.connect(self.db_name)

    def _create_table(self):
        """
        Crea la tabla market_history con las columnas requeridas:
        timestamp, asset, fiat, price y spread.
        """
        query = """
        CREATE TABLE IF NOT EXISTS market_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            asset TEXT NOT NULL,
            fiat TEXT NOT NULL,
            price REAL NOT NULL,
            spread REAL NOT NULL
        )
        """
        try:
            with self._get_connection() as conn:
                conn.execute(query)
                conn.commit()
            logger.info("Base de datos e historial inicializados correctamente.")
        except sqlite3.Error as e:
            logger.error(f"Error crítico inicializando la base de datos: {e}")

    def insert_record(self, asset: str, fiat: str, price: float, spread: float):
        """
        Inserta un nuevo registro en la tabla market_history.
        
        Args:
            asset (str): Ej: 'USDT'
            fiat (str): Ej: 'VES'
            price (float): Precio actual del mercado
            spread (float): Porcentaje de spread calculado
        """
        query = """
        INSERT INTO market_history (asset, fiat, price, spread)
        VALUES (?, ?, ?, ?)
        """
        try:
            with self._get_connection() as conn:
                conn.execute(query, (asset, fiat, price, spread))
                conn.commit()
        except sqlite3.Error as e:
            logger.error(f"Error al insertar registro en market_history: {e}")

    def get_last_records(self, limit: int = 50) -> List[Tuple]:
        """
        Obtiene los últimos N registros del historial para inicializar la lógica del bot.
        Retorna los registros ordenados por el más reciente (descendente).
        
        Returns:
            List[Tuple]: Lista de registros (timestamp, asset, fiat, price, spread)
        """
        query = """
        SELECT timestamp, asset, fiat, price, spread
        FROM market_history
        ORDER BY id DESC
        LIMIT ?
        """
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(query, (limit,))
                results = cursor.fetchall()
                # Invertimos para que el bot los reciba en orden cronológico si es necesario
                return results[::-1] 
        except sqlite3.Error as e:
            logger.error(f"Error al recuperar historial: {e}")
            return []

if __name__ == "__main__":
    # Ejemplo de uso/test
    db = P2PDatabase("p2p_bot_test.db")
    db.insert_record("USDT", "VES", 38.5, 2.1)
    print(f"Historial recuperado: {db.get_last_records(5)}")
