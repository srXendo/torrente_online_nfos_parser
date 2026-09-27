"""Small math helpers: decomposing the engine's row-major bind matrices into
glTF-style TRS, and building world/inverse-bind matrices for skinning."""
from __future__ import annotations
import numpy as np


def decompose_row_major_local(m16):
    """
    m16: 16 floats, row-major, as stored in TRA1 INFO chunks.
    Row-vector convention: row0/1/2 = local X/Y/Z basis vectors (may include
    scale), row3 = translation, i.e. a point p transforms as p' = p @ M.

    Returns (translation(3,), quaternion_xyzw(4,), scale(3,)) using the
    standard glTF/column-vector convention (p' = M @ p), obtained by
    transposing the 3x3 basis block.
    """
    M = np.asarray(m16, dtype=np.float64).reshape(4, 4)
    translation = M[3, 0:3].copy()
    basis_rows = M[0:3, 0:3]
    scale = np.linalg.norm(basis_rows, axis=1)
    scale_safe = np.where(scale < 1e-12, 1.0, scale)
    rot_rows = basis_rows / scale_safe[:, None]
    # Column-vector rotation matrix: columns are the (normalized) local axes.
    R = rot_rows.T
    quat = quat_from_rotation_matrix(R)
    return translation, quat, scale

def invert_matrix_numpy(matrix_list):
    # Convierte tu lista de listas a un array de numpy y calcula la inversa
    mat = np.array(matrix_list, dtype=float)
    inv_mat = np.linalg.inv(mat)
    # Si necesitas devolverlo como lista de listas normal:
    return inv_mat.tolist()
def quat_from_rotation_matrix(R):
    """R: 3x3 proper rotation matrix (column-vector convention). Returns
    (x, y, z, w)."""
    m = R
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w = 0.25 / s
        x = (m[2, 1] - m[1, 2]) * s
        y = (m[0, 2] - m[2, 0]) * s
        z = (m[1, 0] - m[0, 1]) * s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    n = np.linalg.norm(q)
    return q / n if n > 1e-12 else np.array([0.0, 0.0, 0.0, 1.0])

def flat_to_matrix4x4(flat_list):
    """Convierte una lista plana de 16 floats en una matriz de 4x4 (lista de listas)."""
    return [flat_list[i:i+4] for i in range(0, 16, 4)]

def matrix4x4_to_flat(matrix):
    """Convierte una matriz de 4x4 de vuelta a una lista plana de 16 floats."""
    return [elem for row in matrix for elem in row]
def quat_multiply(q1, q2):
    """Hamilton product q1*q2 = 'apply q2's rotation first, then q1's'.
    Both in (x,y,z,w) order."""
    x1, y1, z1, w1 = q1
    x2, y2, z2, w2 = q2
    return np.array([
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ])
def multiply_matrices(m1, m2):
    # Crea una matriz 4x4 llena de ceros para el resultado
    result = [[0.0] * 4 for _ in range(4)]
    
    # Multiplicación clásica de matrices (Fila x Columna)
    for i in range(4):
        for j in range(4):
            for k in range(4):
                result[i][j] += m1[i][k] * m2[k][j]
                
    return result

def trs_to_matrix(t, q, s):
    """t(3,), q=(x,y,z,w), s(3,) -> 4x4 column-vector convention matrix."""
    x, y, z, w = q
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    M = np.eye(4)
    M[0:3, 0:3] = R * np.asarray(s)[None, :]
    M[0:3, 3] = t
    return M
